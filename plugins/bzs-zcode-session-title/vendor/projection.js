const MODEL_ONLY_VISIBILITY = "model-only";
const FORK_SOURCE = "fork";
const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const TASK_NOTIFICATION_PREFIX = "<task-notification>";
const SUBAGENT_NOTIFICATION_PREFIX = "<subagent-notification>";
const REWIND_NOTICE_MARKERS = [
    "Conversation rewind applied.",
    "Workspace rewind applied."
];
const PROVIDER_CONTEXT_SYNTHETIC_SOURCES = new Set([
    "agent_control_message",
    "background_task",
    "goal-continuation",
    "goal_completion_verification",
    "goal_state_change",
    "plugin_reference",
    "queued_system_notification",
    "resume_goal_state",
    "resume_referenced_session_context",
    "rewind",
    "selection_side_chat",
    "subagent",
    "subagent_message",
    "target_continuation",
    "task_notification",
    "task_status",
    "todo_reminder"
]);
const MODEL_ONLY_TURN_TRIGGER_SOURCES = new Set([
    "background_task",
    "task_notification",
    "subagent",
    "subagent_message",
    "goal-continuation",
    "target_continuation"
]);
export function getConversationMessageProjectionPolicy(message) {
    const info = message.info;
    const parts = message.parts ?? [];
    const semantics = info.semantics;
    if (semantics?.kind === "compact_summary" || info.summary !== undefined) {
        return "providerContextOnly";
    }
    if (semantics) {
        if (semantics.kind === "timeline_event") {
            return "timelineOnly";
        }
        if (semantics.origin === "real_user" && info.synthetic !== true && info.visibility !== MODEL_ONLY_VISIBILITY) {
            return "realUserInput";
        }
        if (info.role === "assistant" && semantics.kind === "assistant_response" && semantics.uiVisibility === "visible" && semantics.transcriptVisibility === "visible") {
            return "visibleAssistant";
        }
        if (semantics.providerVisibility === "visible") {
            return "providerContextOnly";
        }
        if (semantics.kind === "fork_notice") {
            return "timelineOnly";
        }
        if (semantics.origin === "agent_runtime" || semantics.uiVisibility === "hidden" || semantics.transcriptVisibility === "hidden") {
            return "hiddenSynthetic";
        }
    }
    if (info.visibility === MODEL_ONLY_VISIBILITY || hasModelOnlyPart(parts)) {
        return "providerContextOnly";
    }
    if (isTimelineOnlyMessage(info, parts)) {
        return "timelineOnly";
    }
    const source = messageSource(info, parts);
    if (source === FORK_SOURCE) {
        return "timelineOnly";
    }
    if (source && PROVIDER_CONTEXT_SYNTHETIC_SOURCES.has(source)) {
        return "providerContextOnly";
    }
    if (hasLegacySystemReminderContextText(parts)) {
        return "providerContextOnly";
    }
    if ((info.synthetic === true || parts.some((part)=>part.synthetic === true)) && hasLegacyNotificationContextText(parts)) {
        return "providerContextOnly";
    }
    if (info.synthetic === true || parts.some((part)=>part.synthetic === true)) {
        return "hiddenSynthetic";
    }
    return info.role === "assistant" ? "visibleAssistant" : "realUserInput";
}
export function isConversationRealUserTurnStarter(message) {
    return message.info.role === "user" && getConversationMessageProjectionPolicy(message) === "realUserInput";
}
export function getConversationModelOnlyTurnTriggerSource(message) {
    if (message.info.role !== "user") return null;
    if (getConversationMessageProjectionPolicy(message) !== "providerContextOnly") {
        return null;
    }
    const source = messageSource(message.info, message.parts ?? []);
    if (source && MODEL_ONLY_TURN_TRIGGER_SOURCES.has(source)) return source;
    if (hasLegacyNotificationContextText(message.parts ?? [])) return "background_task";
    return null;
}
export function isConversationProviderContextOnlyMessage(message) {
    return getConversationMessageProjectionPolicy(message) === "providerContextOnly";
}
export function isConversationTimelineOnlyMessage(message) {
    return getConversationMessageProjectionPolicy(message) === "timelineOnly";
}
export function isConversationHiddenSyntheticMessage(message) {
    return getConversationMessageProjectionPolicy(message) === "hiddenSynthetic";
}
function isTimelineOnlyMessage(info, parts) {
    if (info.semantics?.kind === "timeline_event") {
        return true;
    }
    const infoMetadata = metadataRecord(info.metadata);
    if (info.source === FORK_SOURCE || stringValue(infoMetadata?.source) === FORK_SOURCE) {
        return true;
    }
    return parts.some((part)=>{
        const metadata = metadataRecord(part.metadata);
        return part.type === "timeline" || hasSessionForkContext(metadata) || part.type === "compaction" && (typeof metadata?.timelineStatus === "string" || typeof part.summaryMessageId === "string");
    });
}
function hasModelOnlyPart(parts) {
    return parts.some((part)=>{
        const metadata = metadataRecord(part.metadata);
        return metadata?.visibility === MODEL_ONLY_VISIBILITY || stringValue(metadata?.source) === "goal-continuation";
    });
}
function messageSource(info, parts) {
    const infoMetadata = metadataRecord(info.metadata);
    return info.source ?? stringValue(infoMetadata?.source) ?? info.semantics?.source ?? parts.map((part)=>stringValue(metadataRecord(part.metadata)?.source)).find((source)=>Boolean(source));
}
function hasLegacySystemReminderContextText(parts) {
    const text = textFromParts(parts).trimStart();
    return text.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX) || text.startsWith("<system-reminder>") && (text.includes(GOAL_CONTINUATION_TEXT_MARKER) || text.includes(GOAL_STATE_TEXT_MARKER)) || REWIND_NOTICE_MARKERS.some((marker)=>text.includes(marker));
}
function hasLegacyNotificationContextText(parts) {
    const text = textFromParts(parts).trimStart();
    return text.startsWith(TASK_NOTIFICATION_PREFIX) || text.startsWith(SUBAGENT_NOTIFICATION_PREFIX);
}
function textFromParts(parts) {
    return parts.filter((part)=>part.type === "text" && part.ignored !== true).map((part)=>part.text ?? "").join("");
}
function hasSessionForkContext(metadata) {
    const forkContext = metadataRecord(metadata)?.forkContext;
    return typeof forkContext === "object" && forkContext !== null && !Array.isArray(forkContext) && forkContext.kind === "session_fork";
}
function metadataRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
