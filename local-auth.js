const crypto = require('crypto');
const { localQuery } = require('./local-db');

// The desktop synchronisation assistant is an explicitly authorised local
// integration.  Its encrypted authorisation is intentionally retained for
// 30 days, rather than being invalidated after one working day.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const normaliseRoles = roles => Array.isArray(roles) ? roles : String(roles || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function passwordMatches(password, stored) {
  const [kind, salt, digest] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !digest) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(digest, 'hex'));
}

async function localLogin(identity, password) {
  const result = await localQuery(`select u.id, u.email, u.phone, u.password_hash, p.display_name, p.is_active,
    coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
    from auth.users u join public.profiles p on p.id = u.id
    left join public.user_roles r on r.user_id = u.id
    where lower(coalesce(u.email, '')) = lower($1) or u.phone = $1
    group by u.id, u.email, u.phone, u.password_hash, p.display_name, p.is_active`, [identity]);
  const user = result.rows[0];
  if (!user || !user.is_active || !passwordMatches(password, user.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await localQuery('insert into public.local_sessions (user_id, token_hash, expires_at) values ($1, $2, $3)', [user.id, hashToken(token), expiresAt]);
  return { token, expiresAt: Math.floor(expiresAt.getTime() / 1000), user: { id: user.id, email: user.email, phone: user.phone, displayName: user.display_name || user.email || user.phone }, roles: normaliseRoles(user.roles) };
}

async function localSession(token) {
  const result = await localQuery(`select u.id, u.email, u.phone, p.display_name, p.is_active,
    coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
    from public.local_sessions s join auth.users u on u.id = s.user_id
    join public.profiles p on p.id = u.id left join public.user_roles r on r.user_id = u.id
    where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
    group by u.id, u.email, u.phone, p.display_name, p.is_active`, [hashToken(token)]);
  const user = result.rows[0];
  if (!user?.is_active) return null;
  await localQuery('update public.local_sessions set last_seen_at = now() where token_hash = $1', [hashToken(token)]);
  return { id: user.id, email: user.email, phone: user.phone, displayName: user.display_name || user.email || user.phone, roles: normaliseRoles(user.roles) };
}

module.exports = { localLogin, localSession, passwordHash };
