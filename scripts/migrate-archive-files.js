const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function env(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
}

const sourceEnv = env(path.join(__dirname, '..', '.env'));
const targetEnv = env(path.join(__dirname, '..', '.env.archive-target'));
const source = createClient(sourceEnv.SUPABASE_URL, sourceEnv.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const target = createClient(targetEnv.TARGET_SUPABASE_URL, targetEnv.TARGET_SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const bucket = 'import-archives';

async function main() {
  const { data: archives, error } = await source.from('import_archives').select('*').order('archived_at', { ascending: true });
  if (error) throw error;
  for (const archive of archives || []) {
    const { data: existing, error: existingError } = await target.from('import_archives').select('id, sha256').eq('batch_id', archive.batch_id).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.sha256 === archive.sha256) { console.log(JSON.stringify({ skipped: archive.storage_path })); continue; }
    const { data: file, error: downloadError } = await source.storage.from(bucket).download(archive.storage_path);
    if (downloadError) throw downloadError;
    const content = Buffer.from(await file.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    if (sha256 !== archive.sha256) throw new Error(`源归档文件哈希不匹配：${archive.storage_path}`);
    const { error: uploadError } = await target.storage.from(bucket).upload(archive.storage_path, content, { contentType: archive.source_content_type, upsert: true });
    if (uploadError) throw uploadError;
    const { data: targetFile, error: verifyError } = await target.storage.from(bucket).download(archive.storage_path);
    if (verifyError) throw verifyError;
    const targetHash = crypto.createHash('sha256').update(Buffer.from(await targetFile.arrayBuffer())).digest('hex');
    if (targetHash !== archive.sha256) throw new Error(`目标归档文件哈希不匹配：${archive.storage_path}`);
    const payload = { ...archive, archived_by: null };
    const { error: insertError } = await target.from('import_archives').upsert(payload, { onConflict: 'batch_id' });
    if (insertError) throw insertError;
    console.log(JSON.stringify({ migrated: archive.storage_path, bytes: archive.byte_size, sha256 }));
  }
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
