import { db } from "@crm/db";
import { builderContext } from "./builder-runtime";

export async function chatConnections(conversationId: string, userId: string) {
	const { availableConnections } = await builderContext(conversationId, userId);
	const [sources, emailCount, meetingCount] = await Promise.all([
		db.mailboxSync.findMany({
			where: { userId, source: { in: ["gmail", "calendar"] } },
			select: { source: true, status: true, lastSyncedAt: true },
		}),
		db.emailMessage.count({ where: { syncedByUserId: userId } }),
		db.calendarEvent.count({ where: { syncedByUserId: userId } }),
	]);
	const source = (
		name: "gmail" | "calendar",
		connected: boolean,
		count: number,
	) => {
		const sync = sources.find((row) => row.source === name);
		return {
			connected,
			needsReconnect: sync?.status === "NEEDS_RECONNECT",
			access: "read_only" as const,
			lastSyncedAt: sync?.lastSyncedAt?.toISOString() ?? null,
			syncedRecords: count,
		};
	};
	return {
		google: {
			gmail: source("gmail", availableConnections.gmail, emailCount),
			calendar: source("calendar", availableConnections.calendar, meetingCount),
		},
		slack: { connected: availableConnections.slack },
		mcp: availableConnections.mcp.map(({ platformSlug, accessMode }) => ({
			platformSlug,
			accessMode,
		})),
		capabilities: {
			readGoogleDataFrom: "Synced CRM record history",
			sendEmail: false,
			writeGoogleCalendar: false,
			createGoogleTasks: false,
			createCrmTasks:
				"A reviewed team agent can create CRM tasks from permitted history.",
		},
	};
}
