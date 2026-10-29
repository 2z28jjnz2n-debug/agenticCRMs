import { defineTool } from "eve/tools";
import { z } from "zod";
import { chatConnections } from "../lib/chat-connections";
import { purposeOf, requireAttribute } from "../lib/session-purpose";

export default defineTool({
	description:
		"Check this chat owner's native Gmail and Google Calendar connections, sync counts, read-only limits, and actually connected MCP platforms. Use this for email, calendar, and connection capability questions. MCP search alone does not include native Google connections.",
	inputSchema: z.object({}),
	async execute(_input, ctx) {
		if (purposeOf(ctx) !== "builder") {
			throw new Error("Connection inspection requires a private CRM chat.");
		}
		return chatConnections(
			requireAttribute(ctx, "conversationId"),
			requireAttribute(ctx, "userId"),
		);
	},
});
