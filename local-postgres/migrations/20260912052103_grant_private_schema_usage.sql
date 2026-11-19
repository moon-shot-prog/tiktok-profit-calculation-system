-- RLS policies call private helper functions; callers need schema usage as well
-- as EXECUTE on the individual functions.
grant usage on schema private to authenticated;
