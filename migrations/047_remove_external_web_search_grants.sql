-- Eve 0.22.5 executes provider-native web_search without a local authorization hook. Remove every
-- persisted external grant so execution policy never claims that revocation can be enforced.
UPDATE telegram_groups
   SET tool_allowlist = array_remove(tool_allowlist, 'web_search')
 WHERE tool_allowlist @> ARRAY['web_search']::text[];
