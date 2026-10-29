import { afterAll, expect, it } from "bun:test";
import { GMAIL_SCOPE } from "@crm/auth/scopes";
import { db } from "@crm/db";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";

const userId = `mailbox-token-${crypto.randomUUID()}`;

afterAll(async () => {
	await db.user.deleteMany({ where: { id: userId } });
});

it("selects the owner's local Google account row when reading a mailbox token", async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Mailbox Token Test",
			email: `${userId}@example.test`,
		},
	});
	await db.account.create({
		data: {
			id: crypto.randomUUID(),
			accountId: `google-subject-${crypto.randomUUID()}`,
			providerId: "google",
			userId,
			scope: GMAIL_SCOPE,
			accessToken: "sample-mailbox-token",
			accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
		},
	});
	const tokens = new MailboxTokenService(db);
	expect(await tokens.accessTokenFor(userId, "gmail")).toEqual({
		outcome: "ok",
		accessToken: "sample-mailbox-token",
	});
	expect((await tokens.accessTokenFor(userId, "calendar")).outcome).toBe(
		"not-connected",
	);
	expect((await tokens.accessTokenFor("another-user", "gmail")).outcome).toBe(
		"not-connected",
	);
});
