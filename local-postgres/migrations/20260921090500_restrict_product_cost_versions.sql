-- Keep cost history server-managed. The application server uses service_role;
-- browser roles have no grants and no read/write policy.
create policy "product cost versions: service role only"
on public.product_cost_versions
for all to service_role
using (true)
with check (true);
