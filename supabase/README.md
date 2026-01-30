# Supabase Database Setup

This directory contains database migrations and hotfixes for the BookScanner app.

## Required Schema

The app requires the `books_catalog` table with the following columns:
- `id` (uuid, primary key)
- `resolver_key` (text, unique) - Canonical book identifier
- `provider` (text) - Source provider (e.g., 'openLibrary', 'googleBooks')
- `provider_id` (text) - Provider-specific ID
- `title` (text)
- `authors` (text[])
- `isbn13` (text, nullable)
- `isbn10` (text, nullable)
- `publisher` (text, nullable)
- `publish_year` (text, nullable)
- `cover_url` (text, nullable)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

## Applying Migrations

### Path 1: Supabase CLI (Preferred)

```bash
# Link to your project (one-time setup)
supabase link --project-ref <your-project-ref>

# Push all pending migrations
supabase db push

# Or push a specific migration
supabase db push --include-all
```

### Path 2: Supabase Dashboard (Manual)

If you don't have the CLI installed or prefer the Dashboard:

1. Open your project in [Supabase Dashboard](https://supabase.com/dashboard)
2. Navigate to **SQL Editor**
3. Open the hotfix file: `supabase/hotfix/apply_resolver_key.sql`
4. Copy the entire contents
5. Paste into the SQL Editor
6. Click **Run**
7. Verify no errors in the output

## Migrations

| File | Description |
|------|-------------|
| `20260123000001_resolver_tables.sql` | Initial resolver tables |
| `20260127000001_books_catalog.sql` | Create books_catalog table |
| `20260127000002_fix_persistence_permissions.sql` | RLS policies for books_catalog |
| `20260129000001_add_resolver_key.sql` | Add resolver_key column + unique index |

## Hotfixes

| File | Description |
|------|-------------|
| `hotfix/apply_resolver_key.sql` | Dashboard-friendly version of resolver_key migration |

## PostgREST Schema Cache

After applying schema changes, PostgREST needs to reload its cache. This is handled automatically by:

```sql
NOTIFY pgrst, 'reload schema';
```

This statement is included in all migrations and hotfixes. If you still see `PGRST204` errors after applying, wait 30 seconds for the cache to refresh or restart your Supabase project.

## Troubleshooting

### PGRST204: Could not find column 'resolver_key'

This means the column hasn't been added or PostgREST hasn't reloaded its cache.

**Fix:**
1. Apply the migration/hotfix as described above
2. Wait 30 seconds for cache reload
3. If still failing, run manually in SQL Editor:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```

### App works before DB update

The app has runtime capability detection. If `resolver_key` column is missing:
- Persists using legacy mode (provider + provider_id conflict)
- Shows "Legacy Mode" in Diagnostics → Supabase Capabilities
- Full functionality restored after applying migration
