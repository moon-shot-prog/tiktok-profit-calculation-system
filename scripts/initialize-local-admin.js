const { localQuery } = require('../local-db');
const { passwordHash } = require('../local-auth');

(async () => {
  const login = String(process.env.LOCAL_ADMIN_LOGIN || '').trim().toLowerCase();
  const password = String(process.env.LOCAL_ADMIN_PASSWORD || '');
  if (!login || password.length < 10) throw new Error('A login name and password of at least 10 characters are required.');
  const lookup = await localQuery(`select p.id, p.display_name, array_agg(r.role) filter (where r.role is not null) as roles
    from public.profiles p left join public.user_roles r on r.user_id = p.id
    where r.role = 'super_admin' group by p.id, p.display_name`);
  if (lookup.rows.length !== 1) throw new Error('The local database must contain exactly one super administrator.');
  const account = lookup.rows[0];
  const roles = Array.isArray(account.roles)
    ? account.roles
    : String(account.roles || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  if (!roles.some(role => role === 'super_admin' || role === 'admin')) throw new Error('The selected account is not an administrator.');
  await localQuery('update auth.users set email = $1, password_hash = $2, updated_at = now() where id = $3', [login, passwordHash(password), account.id]);
  await localQuery('update public.local_sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [account.id]);
  console.log(`Local administrator initialized: ${account.display_name || 'super_admin'}`);
})().catch(error => { console.error(`Initialization failed: ${error.message}`); process.exit(1); });
