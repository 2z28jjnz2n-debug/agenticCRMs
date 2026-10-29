import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { CALENDAR_SCOPE, GMAIL_SCOPE } from "@crm/auth/scopes";
import { db } from "@crm/db";
import { chatConnections } from "../agent/lib/chat-connections";

const userId = `chat-connections-${crypto.randomUUID()}`;
let conversationId = "";

beforeAll(async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Connection Test",
			email: `${userId}@example.test`,
		},
	});
	const conversation = await db.agentConversation.create({
		data: { userId, kind: "BUILDER" },
		select: { id: true },
	});
	conversationId = conversation.id;
});

beforeEach(async () => {
	await db.account.deleteMany({ where: { userId } });
	await db.mailboxSync.deleteMany({ where: { userId } });
});

afterAll(async () => {
	await db.agentConversation.deleteMany({ where: { id: conversationId } });
	await db.user.deleteMany({ where: { id: userId } });
});

async function connectGoogle() {
	return db.account.create({
		data: {
			id: crypto.randomUUID(),
			accountId: userId,
			userId,
			providerId: "google",
			scope: `${GMAIL_SCOPE},${CALENDAR_SCOPE}`,
			accessToken: "test-access-token",
			refreshToken: "test-refresh-token",
		},
	});
}

describe("native chat connections", () => {
	it("reports Google without an MCP connection or imported history", async () => {
		await connectGoogle();
		const connections = await chatConnections(conversationId, userId);
		expect(connections.google.gmail).toMatchObject({
			connected: true,
			access: "read_only",
			syncedRecords: 0,
		});
		expect(connections.google.calendar.connected).toBe(true);
		expect(connections.mcp).toEqual([]);
		expect(connections.capabilities.sendEmail).toBe(false);
		expect(connections.capabilities.writeGoogleCalendar).toBe(false);
		expect(JSON.stringify(connections)).not.toContain("test-access-token");
		expect(JSON.stringify(connections)).not.toContain("test-refresh-token");
	});

	it("distinguishes an expired grant from a missing connection", async () => {
		await connectGoogle();
		await db.mailboxSync.create({
			data: { userId, source: "gmail", status: "NEEDS_RECONNECT" },
		});
		const connections = await chatConnections(conversationId, userId);
		expect(connections.google.gmail.connected).toBe(true);
		expect(connections.google.gmail.needsReconnect).toBe(true);
		expect(connections.google.calendar.needsReconnect).toBe(false);
	});

	it("updates its answer after Google access is revoked", async () => {
		const account = await connectGoogle();
		expect(
			(await chatConnections(conversationId, userId)).google.gmail.connected,
		).toBe(true);
		await db.account.update({
			where: { id: account.id },
			data: { scope: null },
		});
		const connections = await chatConnections(conversationId, userId);
		expect(connections.google.gmail.connected).toBe(false);
		expect(connections.google.calendar.connected).toBe(false);
	});

	it("refuses another user's conversation", async () => {
		await connectGoogle();
		await expect(
			chatConnections(conversationId, "another-user"),
		).rejects.toThrow("This builder conversation is unavailable.");
	});
});
