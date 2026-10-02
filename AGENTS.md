<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Progress & aturan kerja

- **Baca `PROGRESS.md` dulu** sebelum mengubah apa pun: catatan perubahan (penambahan/perubahan/penghapusan) per file, disusun dari yang terbaru. Perbarui bagian teratasnya setiap kali selesai mengerjakan sesuatu.
- Tes integrasi: `npm test` (vitest, 40 tes Hub ↔ layanan RAG). Jangan melemahkan tes agar lulus.
- Lint: `npm run lint` sudah gagal sejak baseline (error prettier/CRLF repo-wide); pastikan berkas yang Anda buat/belai sendiri lolos `npx eslint <file>`.
