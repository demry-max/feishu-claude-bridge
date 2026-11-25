/**
 * Webhook JSON body. Field set and insertion order match the deployed 1.1 producer.
 * Delivery metadata stays in headers / the local queue, not in this object.
 */
export const WEBHOOK_PAYLOAD_KEYS = [
  'source',
  'type',
  'message_id',
  'chat_id',
  'chat_type',
  'sender_id',
  'sender_type',
  'content',
  'message_type',
  'mentions',
  'reply_to',
  'root_id',
  'thread_id',
  'create_time',
  'event_id',
  'progress_message_id',
  'session_key',
  'is_owner',
  'owner_open_id',
  'workspace_dir',
  'outbox_dir',
  'memory_hint',
];

export function buildWebhookPayload(f) {
  return {
    source: 'feishu-grok-bridge',
    type: 'im.message.receive_v1',
    message_id: f.message_id,
    chat_id: f.chat_id,
    chat_type: f.chat_type,
    sender_id: f.sender_id,
    sender_type: f.sender_type,
    content: f.content,
    message_type: f.message_type || 'text',
    mentions: f.mentions || [],
    reply_to: f.reply_to || null,
    root_id: f.root_id || null,
    thread_id: f.thread_id || null,
    create_time: f.create_time || null,
    event_id: f.event_id || null,
    progress_message_id: f.progress_message_id || null,
    session_key: f.session_key,
    is_owner: f.is_owner,
    owner_open_id: f.owner_open_id || null,
    workspace_dir: f.workspace_dir,
    outbox_dir: f.outbox_dir,
    memory_hint: f.memory_hint ?? null,
  };
}
