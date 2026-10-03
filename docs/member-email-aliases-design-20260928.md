# メンバーメールエイリアス設計（1人複数アドレス）

**日付:** 2026-09-28  
**起案:** 自動生成（要件: 八坂）  
**状態:** 設計レビュー待ち  
**動機:** メール移行後、同一人物に複数アドレスが存在（tyasaka@tokyo307inc.com → taiyo.yasaka@tokyo307inc.com）。bindVoter が member_not_active で失敗。将来テナントでも同様。  
**カタログ候補ID:** P1-ALIAS

---

## 0. 問題

TOKYO307 オーナー八坂には2つのアドレスがある:
- `tyasaka@tokyo307inc.com` — org_members 行（status=invited, user_id=null）
- `taiyo.yasaka@tokyo307inc.com` — Slack U415HCDAB にバインド済み

どちらも Supabase auth user が未登録。approvalWorkflow.bindVoter が `member_not_active` で失敗。

**現状の制約:**
- `org_members.email` は 1 行につき 1 アドレス
- 招待／ログイン時、別アドレスで auth user を作成すると重複 member が発生
- approver matching は `org_members.email` の完全一致のみ

---

## 1. スコープ

1 つの `org_members` 行に複数の検証済みメールアドレスを紐付け、以下で同一人物を認識:

| # | タッチポイント | 現行ファイル |
|---|--------------|-------------|
| 1 | 招待受諾／ログイン | `lib/auth/session.ts`, `app/onboarding/page.tsx` |
| 2 | 承認者マッチング | `lib/approval-workflow/voter-binding.ts`, `lib/data/members.ts` |
| 3 | parties internal/external 分類 | `lib/gateway/audience.ts`, `lib/data/parties.ts` |
| 4 | 受信メール振り分け | `lib/mail/intake.ts`, `lib/employees/employee-identity.ts` |

---

## 2. セキュリティ要件（セキュリティ監査観点）

### 2.1 アカウント乗っ取り防止

| 脅威 | 対策 |
|-----|------|
| エイリアス追加がアカウント乗っ取りベクトル | **always_human** 承認クラス（admin）＋所有証明必須 |
| 所有証明なしでエイリアス有効化 | 検証メール OTP リンク、verified_at まで pending |
| 検証リンク盗用 | 15 分 TTL、HMAC ハッシュ、5 回失敗ロック |

### 2.2 一意性と名寄せ

| 脅威 | 対策 |
|-----|------|
| 同一アドレスが複数 org_member に紐付く | グローバルユニーク制約（org_member_emails.email_normalized） |
| ドメイン一致だけで自動マージ | **禁止**: 管理者が明示的に追加＋本人検証のみ |
| ケース / plus / IDN 同形異字攻撃 | email_normalized は小文字化 + plus 削除 + IDN 正規化（Punycode） |

### 2.3 ロックアウト防止

| 脅威 | 対策 |
|-----|------|
| プライマリアドレス削除でログイン不能 | プライマリ（org_members.email）削除禁止 |
| 最後の検証済みアドレス削除 | verified カウント >= 1 制約 |
| owner 権限剥奪 | 既存 owner 保護ロジック継承 |

### 2.4 監査

| イベント | 監査メタデータ |
|---------|--------------|
| `member.alias_requested` | memberId, aliasEmail, requestedBy |
| `member.alias_verified` | memberId, aliasEmail, verifiedAt |
| `member.alias_removed` | memberId, aliasEmail, removedBy |

**禁止:** トークン／OTP ハッシュを監査 metadata に記録しない。

---

## 3. データモデル

### 3.1 新テーブル: `org_member_emails`

```sql
create table if not exists org_member_emails (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references org_members(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  email_raw text not null,
  email_normalized text not null,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'revoked')),
  is_primary boolean not null default false,
  source text not null default 'admin_add'
    check (source in ('admin_add', 'signup', 'invite', 'migration')),
  verification_hash text,
  verification_expiry timestamptz,
  failed_verification_attempts integer not null default 0,
  verified_at timestamptz,
  verified_by uuid references org_members(id),
  revoked_at timestamptz,
  revoked_by uuid references org_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 正規化メールはグローバルユニーク（同一アドレスが複数メンバーに紐付くのを防ぐ）
create unique index org_member_emails_normalized_idx
  on org_member_emails (email_normalized)
  where status != 'revoked';

-- メンバーごとのエイリアス検索
create index org_member_emails_member_idx
  on org_member_emails (member_id, status);

-- org 内メールアドレス検索（audience 判定用）
create index org_member_emails_org_email_idx
  on org_member_emails (org_id, email_normalized)
  where status = 'verified';

-- プライマリは各メンバーに1つだけ
create unique index org_member_emails_one_primary_per_member
  on org_member_emails (member_id)
  where is_primary;
```

### 3.2 正規化関数

```typescript
// lib/data/email-normalize.ts
export function normalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const [local, domain] = lower.split('@');
  if (!domain) return lower;
  
  // plus-addressing 削除 (user+tag@domain → user@domain)
  const localWithoutPlus = local.split('+')[0];
  
  // IDN 正規化 (Punycode)
  let normalizedDomain = domain;
  try {
    const url = new URL(`http://${domain}`);
    normalizedDomain = url.hostname;
  } catch {
    // 無効なドメインはそのまま
  }
  
  return `${localWithoutPlus}@${normalizedDomain}`;
}

// 同形異字検出（IDN homoglyph）
export function detectHomoglyphRisk(email: string): boolean {
  const normalized = normalizeEmail(email);
  // Punycode 変換で長さが変わった場合、非ASCII混入
  return /[^\x00-\x7F]/.test(email) || normalized.includes('xn--');
}
```

### 3.3 RLS ポリシー

```sql
alter table org_member_emails enable row level security;

drop policy if exists org_member_emails_select on org_member_emails;
drop policy if exists org_member_emails_write_admin on org_member_emails;

create policy org_member_emails_select on org_member_emails
  for select using (public.is_org_member(org_id));

create policy org_member_emails_write_admin on org_member_emails
  for all using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
```

---

## 4. タッチポイント別変更

### 4.1 招待受諾 / ログイン

**ファイル:**
- `lib/auth/session.ts` — `getSessionContext`, `createOrgWithOwner`
- `app/onboarding/page.tsx`

**変更:**
```typescript
// lib/auth/session.ts
async function findMemberByEmail(
  orgId: string, 
  email: string
): Promise<OrgMember | null> {
  const normalized = normalizeEmail(email);
  
  // 1. org_members.email で検索（既存互換）
  const member = await getMemberByEmail(orgId, email);
  if (member) return member;
  
  // 2. org_member_emails で検索（verified のみ）
  const alias = await findVerifiedAlias(orgId, normalized);
  if (alias) {
    return getMemberById(alias.memberId, orgId);
  }
  
  return null;
}

// 招待受諾フロー
async function acceptInvitation(authUser: AuthUser): Promise<OrgMember> {
  const normalized = normalizeEmail(authUser.email);
  
  // 既存 invited メンバーをエイリアスで検索
  const existingMember = await findMemberByEmail(orgId, authUser.email);
  
  if (existingMember && existingMember.status === 'invited') {
    // 重複作成ではなく既存をバインド
    await bindAuthUserToMember(existingMember.id, authUser.id);
    return existingMember;
  }
  
  // 新規メンバー作成（従来ロジック）
  return createNewMember(authUser);
}
```

### 4.2 承認者マッチング

**ファイル:**
- `lib/approval-workflow/voter-binding.ts` — `checkMemberBelongsToOrg`
- `lib/data/members.ts` — `getMemberByEmail`

**変更:**
```typescript
// lib/data/members.ts
export async function getMemberByAnyEmail(
  orgId: string,
  email: string
): Promise<OrgMember | null> {
  const normalized = normalizeEmail(email);
  
  // 1. プライマリ検索
  const byPrimary = await getMemberByEmail(orgId, email);
  if (byPrimary) return byPrimary;
  
  // 2. エイリアス検索（verified のみ）
  const alias = await findVerifiedAlias(orgId, normalized);
  if (!alias) return null;
  
  return getMemberById(alias.memberId, orgId);
}

// lib/approval-workflow/voter-binding.ts
// checkMemberBelongsToOrg は既存のまま（member_id ベース）
// Slack/LINE バインド時に member 特定で getMemberByAnyEmail を使用
```

### 4.3 parties internal/external 分類

**ファイル:**
- `lib/gateway/audience.ts` — `resolveAudience`
- `lib/data/parties.ts`

**変更:**
```typescript
// lib/gateway/audience.ts
async function isInternalEmailParty(
  orgId: string,
  email: string
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  
  // 1. org_parties でドメイン/個別メール登録を確認
  const party = await findPartyByEmail(orgId, email);
  if (party) return party.audience === 'internal';
  
  // 2. org_member_emails で verified メンバーか確認
  const alias = await findVerifiedAlias(orgId, normalized);
  if (alias) return true; // メンバーは internal
  
  // 3. org_members.email で確認（既存互換）
  const member = await getMemberByEmail(orgId, email);
  if (member) return true;
  
  return false; // fail-closed → external
}
```

### 4.4 受信メール振り分け

**ファイル:**
- `lib/mail/intake.ts`（新規または既存）
- `lib/employees/employee-identity.ts` — `bindMailbox`

**変更:**
```typescript
// lib/mail/intake.ts
async function routeInboundMail(
  orgId: string,
  toEmail: string
): Promise<{ employeeId: string; memberId: string } | null> {
  const normalized = normalizeEmail(toEmail);
  
  // 1. AgentMail inbox を検索（AI 社員メールボックス）
  const inbox = await findAgentMailInbox(orgId, normalized);
  if (inbox) {
    return { employeeId: inbox.employeeId, memberId: inbox.responsibleMemberId };
  }
  
  // 2. org_member_emails で責任者検索
  const alias = await findVerifiedAlias(orgId, normalized);
  if (alias) {
    // メンバーに紐付く AI 社員を取得（identity binding 経由）
    const bindings = await listIdentityBindingsByMember(orgId, alias.memberId);
    if (bindings.length > 0) {
      return { employeeId: bindings[0].employeeId, memberId: alias.memberId };
    }
  }
  
  return null; // ルーティング不可
}
```

---

## 5. Admin MCP ツール

### 5.1 ツール定義

| ツール | 承認クラス | 説明 |
|-------|----------|------|
| `members.aliasAdd` | always_human (admin) | エイリアス追加リクエスト → pending |
| `members.aliasVerify` | 自動（OTP 検証） | 検証コード確認 → verified |
| `members.aliasRemove` | always_human (admin) | エイリアス削除 → revoked |
| `members.aliasList` | 不要 | メンバーのエイリアス一覧 |
| `members.aliasResendVerification` | always_human (admin) | 検証メール再送 |

### 5.2 実装

```typescript
// lib/admin-mcp/members-alias.ts

interface AliasAddInput {
  memberId: string;
  email: string;
}

interface AliasAddResult {
  ok: true;
  aliasId: string;
  verificationEmailSent: boolean;
  messageJa: string;
} | {
  ok: false;
  code: string;
  messageJa: string;
};

export async function membersAliasAdd(
  cred: ResolvedAdminCredential,
  input: AliasAddInput
): Promise<AliasAddResult> {
  const normalized = normalizeEmail(input.email);
  
  // 1. 同形異字リスク検出
  if (detectHomoglyphRisk(input.email)) {
    return {
      ok: false,
      code: 'homoglyph_risk',
      messageJa: 'このアドレスには非ASCII文字が含まれています。正規のアドレスか確認してください。',
    };
  }
  
  // 2. グローバルユニーク確認
  const existing = await findAnyAliasByNormalized(normalized);
  if (existing && existing.status !== 'revoked') {
    return {
      ok: false,
      code: 'email_already_registered',
      messageJa: 'このアドレスは既に別のメンバーに登録されています。',
    };
  }
  
  // 3. メンバー存在確認
  const member = await getMemberById(input.memberId, cred.orgId);
  if (!member) {
    return { ok: false, code: 'member_not_found', messageJa: 'メンバーが見つかりません。' };
  }
  
  // 4. pending エイリアス作成
  const verificationCode = generateVerificationCode();
  const verificationHash = hashVerificationCode(verificationCode, getSecret());
  
  const alias = await createAlias({
    memberId: input.memberId,
    orgId: cred.orgId,
    emailRaw: input.email,
    emailNormalized: normalized,
    status: 'pending',
    source: 'admin_add',
    verificationHash,
    verificationExpiry: new Date(Date.now() + 15 * 60 * 1000),
  });
  
  // 5. 検証メール送信
  await sendVerificationEmail(input.email, verificationCode, member.displayName);
  
  // 6. 監査
  await writeAuditEvent({
    orgId: cred.orgId,
    action: 'member.alias_requested',
    summary: `エイリアス追加リクエスト: ${input.email}`,
    metadata: { memberId: input.memberId, aliasEmail: input.email },
  });
  
  return {
    ok: true,
    aliasId: alias.id,
    verificationEmailSent: true,
    messageJa: `${input.email} に検証メールを送信しました。15分以内にリンクをクリックしてください。`,
  };
}

export async function membersAliasVerify(
  input: { aliasId: string; verificationCode: string }
): Promise<{ ok: true; messageJa: string } | { ok: false; code: string; messageJa: string }> {
  const alias = await getAliasById(input.aliasId);
  if (!alias) {
    return { ok: false, code: 'alias_not_found', messageJa: 'エイリアスが見つかりません。' };
  }
  
  if (alias.status === 'verified') {
    return { ok: false, code: 'already_verified', messageJa: '既に検証済みです。' };
  }
  
  if (alias.failedVerificationAttempts >= 5) {
    return { ok: false, code: 'verification_locked', messageJa: '検証試行回数の上限に達しました。' };
  }
  
  if (!alias.verificationExpiry || new Date() > alias.verificationExpiry) {
    return { ok: false, code: 'verification_expired', messageJa: '検証コードの有効期限が切れています。' };
  }
  
  const actualHash = hashVerificationCode(input.verificationCode, getSecret());
  if (!timingSafeEqual(Buffer.from(alias.verificationHash), Buffer.from(actualHash))) {
    await incrementFailedAttempts(alias.id);
    return { ok: false, code: 'invalid_code', messageJa: '検証コードが一致しません。' };
  }
  
  await updateAlias(alias.id, {
    status: 'verified',
    verifiedAt: new Date().toISOString(),
    verificationHash: null,
    verificationExpiry: null,
  });
  
  await writeAuditEvent({
    orgId: alias.orgId,
    action: 'member.alias_verified',
    summary: `エイリアス検証完了: ${alias.emailRaw}`,
    metadata: { memberId: alias.memberId, aliasEmail: alias.emailRaw },
  });
  
  return { ok: true, messageJa: `${alias.emailRaw} を検証しました。` };
}

export async function membersAliasRemove(
  cred: ResolvedAdminCredential,
  input: { aliasId: string }
): Promise<{ ok: true; messageJa: string } | { ok: false; code: string; messageJa: string }> {
  const alias = await getAliasById(input.aliasId);
  if (!alias || alias.orgId !== cred.orgId) {
    return { ok: false, code: 'alias_not_found', messageJa: 'エイリアスが見つかりません。' };
  }
  
  // プライマリ削除禁止
  if (alias.isPrimary) {
    return {
      ok: false,
      code: 'cannot_remove_primary',
      messageJa: 'プライマリアドレスは削除できません。',
    };
  }
  
  // 最後の verified 削除禁止
  const verifiedCount = await countVerifiedAliases(alias.memberId);
  if (verifiedCount <= 1 && alias.status === 'verified') {
    return {
      ok: false,
      code: 'cannot_remove_last_verified',
      messageJa: '最後の検証済みアドレスは削除できません。',
    };
  }
  
  await updateAlias(alias.id, {
    status: 'revoked',
    revokedAt: new Date().toISOString(),
    revokedBy: cred.actorMemberId,
  });
  
  await writeAuditEvent({
    orgId: alias.orgId,
    action: 'member.alias_removed',
    summary: `エイリアス削除: ${alias.emailRaw}`,
    metadata: { memberId: alias.memberId, aliasEmail: alias.emailRaw },
  });
  
  return { ok: true, messageJa: `${alias.emailRaw} を削除しました。` };
}
```

### 5.3 audit-class 追加

```typescript
// lib/admin-mcp/audit-class.ts 追記
export const ADMIN_TOOL_AUDIT_ACTION: Record<string, AdminAuditAction> = {
  // ... 既存
  "members.aliasAdd": "admin.policy",
  "members.aliasRemove": "admin.policy",
  "members.aliasResendVerification": "admin.policy",
};
```

---

## 6. マイグレーション計画

### 6.1 マイグレーションファイル

```sql
-- supabase/migrations/20260928000000_member_email_aliases.sql

-- 1. テーブル作成
create table if not exists org_member_emails (
  -- (上記 3.1 参照)
);

-- 2. 既存 org_members.email をプライマリとしてバックフィル
insert into org_member_emails (
  member_id,
  org_id,
  email_raw,
  email_normalized,
  status,
  is_primary,
  source,
  verified_at,
  created_at
)
select
  m.id as member_id,
  m.org_id,
  m.email as email_raw,
  lower(trim(m.email)) as email_normalized,
  'verified' as status,
  true as is_primary,
  'migration' as source,
  coalesce(m.created_at, now()) as verified_at,
  now() as created_at
from org_members m
where not exists (
  select 1 from org_member_emails e
  where e.member_id = m.id and e.is_primary
);

-- 3. RLS 有効化
alter table org_member_emails enable row level security;
-- (ポリシー作成は上記 3.3 参照)
```

### 6.2 フィーチャーフラグ

```typescript
// lib/feature-flags.ts 追記

/**
 * P1-ALIAS: Member email aliases (multi-email per member).
 *
 * When ON:
 * - members.aliasAdd/aliasVerify/aliasRemove Admin MCP tools enabled.
 * - Login/invite acceptance searches org_member_emails for existing members.
 * - Approval voter matching uses aliases.
 * - Audience classification considers verified aliases as internal.
 *
 * When OFF (default):
 * - Existing single-email behavior preserved.
 * - org_member_emails table exists but is not queried.
 */
export function isMemberEmailAliasesEnabled(): boolean {
  return parseFlag(process.env.P1_MEMBER_EMAIL_ALIASES_ENABLED);
}
```

### 6.3 ロールアウト手順

| ステップ | 内容 | リスク |
|---------|------|-------|
| 1 | マイグレーション適用（テーブル作成 + バックフィル） | 低: 追加のみ |
| 2 | フラグ OFF のまま本番デプロイ | 低: 既存動作変更なし |
| 3 | ステージングでフラグ ON、テスト | 中: 機能検証 |
| 4 | TOKYO307 パイロットでフラグ ON | 中: 限定テナント |
| 5 | 全テナントでフラグ ON | 低: 検証済み |

---

## 7. テスト計画

### 7.1 ユニットテスト

| テスト | ファイル |
|-------|---------|
| normalizeEmail: plus-addressing 削除 | `lib/data/email-normalize.test.ts` |
| normalizeEmail: IDN 正規化 | 同上 |
| detectHomoglyphRisk: 非 ASCII 検出 | 同上 |
| membersAliasAdd: 重複拒否 | `lib/admin-mcp/members-alias.test.ts` |
| membersAliasAdd: 同形異字警告 | 同上 |
| membersAliasVerify: 有効期限切れ拒否 | 同上 |
| membersAliasVerify: 5 回失敗ロック | 同上 |
| membersAliasRemove: プライマリ削除禁止 | 同上 |
| membersAliasRemove: 最後の verified 削除禁止 | 同上 |

### 7.2 統合テスト

| テスト | ファイル |
|-------|---------|
| ログイン: エイリアスで既存 invited メンバーにバインド | `tests/integration/auth-alias.test.ts` |
| bindVoter: エイリアスで member 特定 | `tests/integration/voter-binding-alias.test.ts` |
| audience: verified エイリアスは internal | `tests/integration/audience-alias.test.ts` |
| mail intake: エイリアスでルーティング | `tests/integration/mail-intake-alias.test.ts` |

### 7.3 セキュリティテスト

| テスト | ファイル |
|-------|---------|
| クロスオルグ: 他オルグのエイリアスは取得不可 | `tests/security/alias-cross-org.test.ts` |
| RLS: service_role 以外は secrets 列アクセス不可 | 同上 |
| 検証コード: タイミング攻撃耐性 | `tests/security/alias-timing.test.ts` |
| グローバルユニーク: 同一メールを別メンバーに追加不可 | `tests/security/alias-unique.test.ts` |

---

## 8. 実装見積もり

### PR 分割

| PR | 内容 | 行数目安 | ファイル数 | エージェント時間 |
|----|------|---------|-----------|----------------|
| PR1 | データモデル + マイグレーション + RLS | ~200 | 3 | 2h |
| PR2 | email-normalize.ts + ユニットテスト | ~150 | 2 | 1.5h |
| PR3 | Admin MCP ツール (aliasAdd/Verify/Remove/List) | ~400 | 4 | 4h |
| PR4 | フィーチャーフラグ + 招待/ログイン統合 | ~250 | 4 | 3h |
| PR5 | 承認者マッチング統合 + テスト | ~200 | 3 | 2h |
| PR6 | audience 分類統合 + テスト | ~150 | 2 | 1.5h |
| PR7 | mail intake 統合 + テスト | ~150 | 2 | 1.5h |
| PR8 | セキュリティテスト + E2E | ~200 | 3 | 2h |
| PR9 | ドキュメント + ロールアウト手順 | ~100 | 2 | 1h |

### 合計

| 指標 | 値 |
|-----|-----|
| 総行数 | ~1,800 行 |
| 総ファイル数 | ~25 ファイル |
| 総エージェント時間 | **18.5h** |

---

## 9. 非目標（P1 外）

- SSO プロバイダー連携（SAML / OIDC でのエイリアス自動同期）
- メールアドレス変更履歴 UI（監査ログで代替）
- 複数オルグにまたがる同一人物のアカウントマージ
- エイリアスの優先順位設定（通知先選択）

---

## 10. 受け入れ条件（AC）

| # | AC |
|---|-----|
| A1 | フラグ OFF で既存動作に回帰なし |
| A2 | aliasAdd → 検証メール送信 → aliasVerify で verified |
| A3 | verified エイリアスでログイン時、既存 invited メンバーにバインド |
| A4 | bindVoter がエイリアスで member を特定可能 |
| A5 | verified エイリアスは audience internal として扱われる |
| A6 | プライマリ削除は拒否される |
| A7 | 最後の verified 削除は拒否される |
| A8 | 同一メールを別メンバーに追加しようとするとエラー |
| A9 | 監査イベントに alias_requested / verified / removed が記録される |
| A10 | TOKYO307 八坂のケース（2 アドレス）で bindVoter 成功 |
