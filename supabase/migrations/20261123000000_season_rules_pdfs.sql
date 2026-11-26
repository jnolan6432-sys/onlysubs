alter table public.seasons
  add column rules_pdf_url text,
  add column rules_pdf_name text;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'season-docs',
  'season-docs',
  true,
  10485760,
  array['application/pdf']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Admins can upload season PDFs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'season-docs'
    and (select public.is_admin())
  );

create policy "Admins can remove season PDFs"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'season-docs'
    and (select public.is_admin())
  );
