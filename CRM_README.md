# Swilcan Outreach CRM

The CRM is a private authenticated application served from the existing GitHub
Pages site at `/crm/`. GitHub Pages serves the browser UI. Supabase provides
authentication and shared persistent storage.

## Workflow

1. A scheduled prospecting workflow adds five researched contacts each week
   and emails Bill and Selena a link to Prospect Review.
2. Bill or Selena approves or declines each contact. Declines require a reason
   and retain feedback for subsequent research prompts.
   Only one attorney per firm may be pending or in an active workflow. Another
   attorney at that firm becomes eligible only after the prior attorney finishes
   the complete non-response cadence and the CRM requests an alternate contact.
3. Approval requires a sourced public business email, moves the complete
   research record into Prospecting, and creates an unsent draft in Selena's
   verified Swilcan Google Workspace mailbox. Nothing sends automatically.
4. Drafts follow a short Sandler-style cadence: one-sentence initial question,
   seven-day nudge, then a 30-day close-the-loop/alternate-contact question.
   Due drafts are created when the authenticated CRM is opened; sends remain manual.
5. After three non-responses, the workflow requests another entry point at the
   organization. After three failed entry points, the organization closes cold.
6. An affirmative reply moves the same record into In Conversation with its source,
   rationale, research, draft history, and activity timeline intact. The
   remaining stages are Proposal and Won.
7. Moving In Conversation to Proposal opens a required engagement-letter form.
   It uses the February 22, 2026 Barnes engagement as the controlled baseline,
   attaches the completed proposal data to the CRM record, and generates a PDF.
   The proposal includes the standard scope, adjustable rates and cancellation
   terms, payment terms, liability language, and signature acceptance blocks.
8. Customer delivery remains draft-only. The authenticated n8n draft service
   uses the Google credential connected as `selena@swilcanforensics.com` and
   exposes no Gmail send operation. Follow-up drafts retain the Gmail thread ID.

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
- Supabase is the shared system of record; bulk browser import/export is not
  part of the operating workflow.
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
