-- Mail threads and messages (Lab1 R2). Old `mail-source:*` dedupe keys in app.settings stay valid.
CREATE TABLE app.mail_threads (
  id text PRIMARY KEY,
  account text NOT NULL,
  subject text NOT NULL,
  subject_key text NOT NULL,
  participants text[] NOT NULL DEFAULT '{}',
  last_message_at timestamptz NOT NULL,
  triage text NOT NULL DEFAULT 'new' CHECK (triage IN ('new','drafting','replied','ignored','bulk','errand')),
  session_id text REFERENCES app.sessions(id),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_threads_recent ON app.mail_threads(account, last_message_at DESC, id);
CREATE INDEX mail_threads_subject ON app.mail_threads(account, subject_key);
CREATE TABLE app.mail_messages (
  id text PRIMARY KEY,
  account text NOT NULL,
  folder text NOT NULL,
  uidvalidity text NOT NULL,
  uid bigint NOT NULL,
  message_id text,
  in_reply_to text,
  references_ids text[] NOT NULL DEFAULT '{}',
  thread_id text NOT NULL REFERENCES app.mail_threads(id),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  from_addr text NOT NULL,
  to_addrs text[] NOT NULL DEFAULT '{}',
  cc_addrs text[] NOT NULL DEFAULT '{}',
  reply_to text,
  subject text NOT NULL,
  sent_at timestamptz,
  body_text text NOT NULL,
  body_origin text NOT NULL CHECK (body_origin IN ('plain','html','composed')),
  raw_digest text NOT NULL,
  bulk boolean NOT NULL DEFAULT false,
  attachments jsonb NOT NULL DEFAULT '[]',
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, folder, uidvalidity, uid)
);
CREATE UNIQUE INDEX mail_messages_message_id ON app.mail_messages(account, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX mail_messages_thread_time ON app.mail_messages(thread_id, sent_at, id);
-- A reply session remembers which thread and message it answers; headers are bound into the send approval.
ALTER TABLE app.sessions ADD COLUMN mail jsonb;
