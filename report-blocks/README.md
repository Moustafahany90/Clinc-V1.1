# report-blocks

Block based report templates. See agent-prompt-blocks.md for the integration plan.

- blocks.types.ts      pure types (also copied to the frontend)
- blocks.schema.ts     Zod schema (strict)
- blocks.validate.ts   cross-field validation, derived fields, initial content
- blocks.render.ts     the ONE renderer (print + edit)
- letterhead.ts        fixed header / footer / signature text
- letterheadLogo.ts    generated logo (base64)
- collectContent.ts    frontend: read values back from the edit-mode iframe
- selfcheck.ts         run: npx tsx selfcheck.ts
- templates/*.json     the 10 report templates (no patient data)
