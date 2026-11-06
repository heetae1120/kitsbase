-- 팀원 계정 (비밀번호는 PBKDF2 해시로만 저장)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#DD3A2E',
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 사업·일정·메모·폴더·팀 메모·마인드맵 문서. seq는 변경 순번(동기화 커서)
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS docs_seq ON docs (seq);
