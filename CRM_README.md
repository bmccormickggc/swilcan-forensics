# Swilcan Outreach CRM

The CRM is a private authenticated application served from the existing GitHub
Pages site at `/crm/`. GitHub Pages serves the browser UI. Supabase provides
authentication and shared persistent storage.

## Workflow

1. Add researched contacts to Candidate Review.
2. Selena approves or rejects each candidate. Approval creates a Prospecting
   card but sends nothing.
3. Move an approved prospect to Outreach Active and choose a next-action date.
4. On the due date, review and copy the generated draft. Selena sends it
   manually from `selena@swilcanforensics.com`.
5. Mark the message sent. The CRM schedules 7-day, 14-day, and 30-day
   follow-ups, then closes the record as cold.
6. A reply moves the record to Conversation. The remaining stages are
   Qualified, Proposal, and Won.

The CRM must not contain patient names, case facts, medical records, or PHI.

## Security model

- Supabase magic-link login with account creation disabled in the application.
- Row Level Security permits CRM reads and writes only when the authenticated
  email is `selena@swilcanforensics.com` or `bill.mccormick14@gmail.com`.
- The browser contains the Supabase anon key, which is intentionally public;
  RLS is the authorization boundary. Never place a service-role key in this
  repository or browser code.
- Optimistic revision checks prevent one browser from silently overwriting a
  newer save.
- JSON export/import provides a portable backup.
- Supabase JavaScript is version-pinned with Subresource Integrity.

## Supabase provisioning

1. Create a Supabase project.
2. Run `supabase/schema.sql` in its SQL editor.
3. In Authentication settings:
   - set Site URL to `https://swilcanforensics.com/crm/`;
   - add `https://swilcanforensics.com/crm/` as an allowed redirect URL;
   - disable public user signups;
   - invite `selena@swilcanforensics.com`.
4. Put the project URL and anon key in `crm/config.js`. The anon key is safe to
   publish because RLS blocks unauthorized database access.
5. Before publishing, validate:
   - an unauthenticated browser sees only the login page;
   - a non-Selena authenticated account cannot select or update `crm_state`;
   - Selena can create, edit, export, and re-import records;
   - two browser sessions trigger revision-conflict protection;
   - no service-role credential appears in the repository.

## Deployment boundary

The implementation is prepared in the actual GitHub repository clone. Do not
push until the Supabase project is provisioned, `crm/config.js` is populated,
and the authenticated test above passes.
