import { afterAll, expect, it } from "bun:test";
import { db } from "@crm/db";
import { AgentTriggerService } from "../../api/src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../../api/src/companies/company-directory.service";
import { ActivityStampService } from "../../api/src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../../api/src/crm/enrichment-log.service";
import {
	CalendarClient,
	type EventsPage,
} from "../../api/src/google/calendar.client";
import { CalendarSyncService } from "../../api/src/google/calendar-sync.service";
import {
	GmailClient,
	type GmailMessage,
	type HistoryList,
	type Profile,
} from "../../api/src/google/gmail.client";
import { GmailSyncService } from "../../api/src/google/gmail-sync.service";
import {
	MailboxApiClient,
	type MailboxResult,
} from "../../api/src/mailbox/mailbox-api.client";
import { MailboxMatchService } from "../../api/src/mailbox/mailbox-match.service";
import {
	MailboxTokenService,
	type TokenResult,
} from "../../api/src/mailbox/mailbox-token.service";
import { SyncStateService } from "../../api/src/mailbox/sync-state.service";
import { ThreadWriterService } from "../../api/src/mailbox/thread-writer.service";
import { createRunActivity, readRunRecord } from "../agent/lib/run-runtime";

const suffix = crypto.randomUUID();
const userId = `google-task-${suffix}`;
const mailbox = `${userId}@example.test`;
const domain = `buyer-${suffix}.example.test`;
const email = `buyer@${domain}`;
const messageId = `google-message-${suffix}`;
const iCalUid = `google-meeting-${suffix}`;
const startsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
let agentId = "";
let contactId = "";
let companyId = "";

class SampleTokens extends MailboxTokenService {
	override async accessTokenFor(): Promise<TokenResult> {
		return { outcome: "ok", accessToken: "sample-only" };
	}
}

class SampleGmail extends GmailClient {
	override async profile(): Promise<MailboxResult<Profile>> {
		return { outcome: "ok", data: { emailAddress: mailbox, historyId: "100" } };
	}
	override async listHistory(): Promise<MailboxResult<HistoryList>> {
		return {
			outcome: "ok",
			data: {
				historyId: "101",
				history: [{ messagesAdded: [{ message: { id: messageId } }] }],
			},
		};
	}
	override async getMessage(): Promise<MailboxResult<GmailMessage>> {
		return {
			outcome: "ok",
			data: {
				id: messageId,
				internalDate: String(Date.now()),
				payload: {
					mimeType: "text/plain",
					headers: [
						{ name: "Message-ID", value: `<${messageId}@example.test>` },
						{ name: "From", value: `Sample Buyer <${email}>` },
						{ name: "To", value: mailbox },
						{ name: "Subject", value: "Send pricing before our meeting" },
					],
					body: {
						data: Buffer.from(
							"Please prepare pricing for our upcoming review.",
						).toString("base64url"),
					},
				},
			},
		};
	}
}

class SampleCalendar extends CalendarClient {
	override async listEvents(): Promise<MailboxResult<EventsPage>> {
		return {
			outcome: "ok",
			data: {
				nextSyncToken: "sample-calendar-cursor",
				items: [
					{
						id: iCalUid,
						iCalUID: iCalUid,
						summary: "Buyer pricing review",
						start: { dateTime: startsAt.toISOString() },
						end: {
							dateTime: new Date(startsAt.getTime() + 3_600_000).toISOString(),
						},
						organizer: { email: mailbox },
						attendees: [
							{
								email,
								displayName: "Sample Buyer",
								responseStatus: "accepted",
							},
						],
					},
				],
			},
		};
	}
}

afterAll(async () => {
	await db.activity.deleteMany({ where: { createdById: userId } });
	await db.emailThread.deleteMany({ where: { contactId } });
	await db.calendarEvent.deleteMany({ where: { syncedByUserId: userId } });
	if (agentId) {
		await db.agentAction.deleteMany({ where: { agentId } });
		await db.agentRun.deleteMany({ where: { agentId } });
		await db.agentDefinition.update({
			where: { id: agentId },
			data: { currentVersionId: null },
		});
		await db.agentVersion.deleteMany({ where: { agentId } });
		await db.agentDefinition.delete({ where: { id: agentId } });
	}
	await db.contact.deleteMany({ where: { id: contactId } });
	await db.company.deleteMany({ where: { id: companyId } });
	await db.user.deleteMany({ where: { id: userId } });
});

it("imports Google email and a meeting, then creates one permitted CRM follow-up task", async () => {
	await db.user.create({
		data: { id: userId, name: "Sample Rep", email: mailbox },
	});
	const company = await db.company.create({
		data: { name: "Sample Buyer Company", domain },
	});
	companyId = company.id;
	const contact = await db.contact.create({
		data: { firstName: "Sample", lastName: "Buyer", email, companyId },
	});
	contactId = contact.id;
	const trigger = new AgentTriggerService(db);
	const stamp = new ActivityStampService(db);
	const match = new MailboxMatchService(
		db,
		new CompanyDirectoryService(trigger),
		trigger,
		new EnrichmentLogService(db, stamp),
	);
	const api = new MailboxApiClient();
	const state = new SyncStateService(db);
	const tokens = new SampleTokens(db);
	const gmail = new GmailSyncService(
		db,
		new SampleGmail(api),
		tokens,
		state,
		new ThreadWriterService(db, match, stamp),
	);
	const calendar = new CalendarSyncService(
		db,
		new SampleCalendar(api),
		tokens,
		match,
		state,
		stamp,
		trigger,
	);
	const gmailRow = await db.mailboxSync.create({
		data: { userId, source: "gmail", autoCreate: false },
	});
	const calendarRow = await db.mailboxSync.create({
		data: { userId, source: "calendar", autoCreate: false },
	});
	expect((await gmail.sync(gmailRow)).status).toBe("synced");
	expect(
		await db.emailMessage.count({ where: { syncedByUserId: userId } }),
	).toBe(0);
	const watching = await db.mailboxSync.findUniqueOrThrow({
		where: { id: gmailRow.id },
	});
	expect(await gmail.sync(watching)).toMatchObject({
		status: "synced",
		messagesWritten: 1,
	});
	expect(await calendar.sync(calendarRow)).toMatchObject({
		status: "synced",
		eventsWritten: 1,
	});
	const agent = await db.agentDefinition.create({
		data: {
			name: "Sample pricing follow-up",
			status: "LIVE",
			createdById: userId,
		},
	});
	agentId = agent.id;
	const version = await db.agentVersion.create({
		data: {
			agentId,
			number: 1,
			status: "DEPLOYED",
			instructions:
				"Create a pricing preparation task from permitted Google history.",
			modelId: "test/model",
			sandboxPolicy: {},
			createdById: userId,
			approvedAt: new Date(),
			deployedAt: new Date(),
			manifest: {
				triggers: [
					{
						type: "MANUAL",
						name: "Run now",
						summary: "Prepare a follow-up",
						config: {},
					},
				],
				dataScope: {
					mode: "SELECTED",
					summary: "Selected contact and Google history",
					resources: [
						{ kind: "contact", id: contactId, label: "Sample Buyer" },
						{ kind: "integration", id: "google:gmail", label: "Gmail" },
						{
							kind: "integration",
							id: "google:calendar",
							label: "Google Calendar",
						},
					],
				},
				actions: [
					{
						type: "crm.activity.create",
						provider: "crm",
						summary: "Create a follow-up",
						activityTypes: ["TASK"],
					},
				],
			},
		},
	});
	await db.agentDefinition.update({
		where: { id: agentId },
		data: { currentVersionId: version.id },
	});
	const run = await db.agentRun.create({
		data: {
			agentId,
			versionId: version.id,
			triggerType: "MANUAL",
			status: "RUNNING",
			startedAt: new Date(),
			idempotencyKey: suffix,
			correlationId: suffix,
			initiatedById: userId,
		},
	});
	const history = await readRunRecord(run.id, {
		kind: "contact",
		id: contactId,
	});
	expect(JSON.stringify(history)).toContain(
		"Please prepare pricing for our upcoming review.",
	);
	expect(JSON.stringify(history)).toContain("Buyer pricing review");
	const task = {
		type: "TASK" as const,
		targetKind: "contact" as const,
		targetId: contactId,
		subject: "Prepare buyer pricing",
		body: "Prepare pricing requested by email before the buyer review.",
		dueAt: new Date(startsAt.getTime() - 86_400_000).toISOString(),
	};
	const created = await createRunActivity(run.id, "sample-follow-up", task);
	expect(created.replayed).toBe(false);
	expect(
		await createRunActivity(run.id, "sample-follow-up", task),
	).toMatchObject({ activityId: created.activityId, replayed: true });
	expect(await db.activity.count({ where: { contactId, type: "TASK" } })).toBe(
		1,
	);
	expect(
		await db.activity.findUnique({ where: { id: created.activityId ?? "" } }),
	).toMatchObject({ subject: task.subject, contactId, createdById: userId });
	await expect(
		createRunActivity(run.id, "out-of-scope", {
			...task,
			targetId: "unapproved-contact",
		}),
	).rejects.toThrow();
	await expect(
		createRunActivity(run.id, "unapproved-note", { ...task, type: "NOTE" }),
	).rejects.toThrow();
});
