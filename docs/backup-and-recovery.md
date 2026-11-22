# CedarBite database backup and recovery

This runbook covers the Supabase PostgreSQL data used by CedarBite. Backups contain student identifiers,
order history, and wallet records. Keep them private, encrypt the offline copy, and never commit them to Git.

## Before changing or deploying the database

1. Confirm migrations `0001` through `0009` have been applied to the intended Supabase project.
2. Pause ordering and cash-desk top-ups while creating the first backup. Record the pause time as the
   backup cut-off.
3. Keep the existing Netlify Blobs intact until student balances and wallet history have been checked.
   The application imports previous wallet records once; do not clear the old store during deployment.

## Create a logical database backup on Windows

Supabase's supported CLI dump uses Docker to run PostgreSQL's dump tooling and filters platform-managed
schemas. Install the Supabase CLI and Docker Desktop if they are not already available. In the Supabase
dashboard, use **Connect** to get the database connection string. Prefer the direct connection when the
network supports it; use the session pooler if direct IPv6 connectivity is unavailable.

The CLI dump is three files: schema, data, and optional custom roles. It excludes Supabase-managed Auth
and Storage schemas, and SQL backups do not include the actual bytes stored in Storage. This is a logical
backup of CedarBite's app tables; it is not a complete clone of the Supabase project. Student accounts
must authenticate again after a logical restore, and menu photos need their own file backup.

Open PowerShell in the project folder. The helper below prompts with hidden input and keeps the database
URL in this PowerShell process only:

```powershell
function Set-CedarDatabaseUrl([string]$Name) {
  $secure = Read-Host "Paste the database connection URL" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Environment]::SetEnvironmentVariable($Name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer), "Process") }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

Set-CedarDatabaseUrl "CEDARBITE_DB_URL"
New-Item -ItemType Directory -Force .\backups | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
supabase db dump --remote="$env:CEDARBITE_DB_URL" -f ".\backups\cedarbite-schema-$stamp.sql"
supabase db dump --remote="$env:CEDARBITE_DB_URL" -f ".\backups\cedarbite-data-$stamp.sql" --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
Get-ChildItem ".\backups\cedarbite-*$stamp.sql" | Select-Object Name, Length, LastWriteTime
```

Both dump commands must exit successfully and produce non-empty files. For a project with custom database
roles, also export them with `supabase db dump --remote="$env:CEDARBITE_DB_URL" -f ".\backups\cedarbite-roles-$stamp.sql" --role-only` before clearing the variable, then run `Remove-Item Env:\CEDARBITE_DB_URL`.
After the optional role export, clear the connection string with `Remove-Item Env:\CEDARBITE_DB_URL`.

Download the `menu-images` bucket contents separately from **Storage** in Supabase and save them beside
the SQL files. Record the bucket path and backup time. Confirm the downloaded file count and sizes; an SQL
dump preserves database metadata only, not the image files themselves.

## Recovery rehearsal into a separate project

Never rehearse by restoring over the live CedarBite database. Create a separate temporary Supabase project
and confirm its project name and host before proceeding. The CLI restore should use an empty target with
the required extensions enabled. Supabase Auth users and Storage objects are not part of the logical dump;
do not expect the old Google sessions or profile-to-user IDs to transfer through this procedure.

Install PostgreSQL command-line tools (`psql`) and set the empty test database URL using the helper above.
Replace the timestamp with the files from the backup being rehearsed:

```powershell
Set-CedarDatabaseUrl "CEDARBITE_TEST_DB_URL"
psql --single-transaction --set ON_ERROR_STOP=1 `
  --file ".\backups\cedarbite-schema-YYYYMMDD-HHMMSS.sql" `
  --command "SET session_replication_role = replica" `
  --file ".\backups\cedarbite-data-YYYYMMDD-HHMMSS.sql" `
  --dbname "$env:CEDARBITE_TEST_DB_URL"
Remove-Item Env:\CEDARBITE_TEST_DB_URL
```

If the restore reports any error, save the full output and stop. Do not retry it against production.

In the test project's SQL editor, verify the CedarBite tables `orders`, `order_audit_events`,
`wallet_accounts`, `wallet_entries`, and `wallet_legacy_imports` exist. Compare order and wallet-entry
counts with the source project at the backup cut-off, then verify several known order IDs and wallet
balances. Confirm that the `menu-images` files are present from the separate Storage backup. Finally,
reapply migrations only if the restored schema is missing them; do not run them blindly over restored
objects. Document the date, source/test project names, counts, and errors. Do not submit real payments from
the rehearsal site.

For a complete project restore that preserves Auth users and project-level settings, use Supabase's
project restore/clone workflow when it is available for the account. Verify Storage files separately;
Supabase database backups do not include Storage object bytes.

## Restore to production after a real incident

Pause ordering and cash handling, preserve the failed project for investigation, and agree on the recovery
point with the Supabase project owner. Restore to a new project where possible, validate the result using
the rehearsal checks, and switch application server settings only after the owner approves the recovered
data. Never make a destructive production restore the first recovery step.

## Rehearsal record

This runbook is prepared; a restore rehearsal has **not** been performed by Codex. It requires the team's
Supabase database connection and an isolated test project. Mark it complete only after a team member runs
and verifies the separate-project restore.
