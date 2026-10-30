const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

async function testDownload() {
  console.log('--- TESTING DYNAMIC AGENT ZIP & SERVER ADDRESS AUTO-FILL ---');

  // Test 1: Download from localhost
  console.log('1. Testing download from localhost:3000');
  const resLocal = await fetch('http://localhost:3000/downloads/PrintQR-Agent.zip');
  if (!resLocal.ok) throw new Error('Local download failed with status ' + resLocal.status);
  const bufLocal = Buffer.from(await resLocal.arrayBuffer());
  const tmpLocal = path.join(os.tmpdir(), 'test_agent_local.zip');
  fs.writeFileSync(tmpLocal, bufLocal);
  
  // Extract and check
  const tmpExtractLocal = path.join(os.tmpdir(), 'test_agent_local_dir');
  fs.rmSync(tmpExtractLocal, { recursive: true, force: true });
  fs.mkdirSync(tmpExtractLocal, { recursive: true });
  execSync(`tar -xf "${tmpLocal}" -C "${tmpExtractLocal}"`);

  const serverUrlLocal = fs.readFileSync(path.join(tmpExtractLocal, 'PrintQR-Agent', 'server_url.txt'), 'utf8').trim();
  const configLocal = JSON.parse(fs.readFileSync(path.join(tmpExtractLocal, 'PrintQR-Agent', 'config.json'), 'utf8'));
  console.log('   ✓ Extracted server_url.txt:', serverUrlLocal);
  console.log('   ✓ Extracted config.json serverUrl:', configLocal.serverUrl);
  if (serverUrlLocal !== 'http://localhost:3000') throw new Error('Expected http://localhost:3000, got ' + serverUrlLocal);

  // Test 2: Simulated Render environment (with x-forwarded-proto and host headers)
  console.log('2. Testing download with Render headers (https://qrprinter-1.onrender.com)');
  const resRender = await fetch('http://localhost:3000/downloads/PrintQR-Agent.zip', {
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'qrprinter-1.onrender.com'
    }
  });
  if (!resRender.ok) throw new Error('Render download failed');
  const bufRender = Buffer.from(await resRender.arrayBuffer());
  const tmpRender = path.join(os.tmpdir(), 'test_agent_render.zip');
  fs.writeFileSync(tmpRender, bufRender);

  const tmpExtractRender = path.join(os.tmpdir(), 'test_agent_render_dir');
  fs.rmSync(tmpExtractRender, { recursive: true, force: true });
  fs.mkdirSync(tmpExtractRender, { recursive: true });
  execSync(`tar -xf "${tmpRender}" -C "${tmpExtractRender}"`);

  const serverUrlRender = fs.readFileSync(path.join(tmpExtractRender, 'PrintQR-Agent', 'server_url.txt'), 'utf8').trim();
  const configRender = JSON.parse(fs.readFileSync(path.join(tmpExtractRender, 'PrintQR-Agent', 'config.json'), 'utf8'));
  console.log('   ✓ Extracted server_url.txt for Render:', serverUrlRender);
  console.log('   ✓ Extracted config.json for Render:', configRender.serverUrl);
  if (serverUrlRender !== 'https://qrprinter-1.onrender.com') throw new Error('Expected https://qrprinter-1.onrender.com, got ' + serverUrlRender);

  // Test 3: Download with query origin parameter (e.g. ?origin=https://customdomain.com)
  console.log('3. Testing download with origin query parameter (?origin=https://customdomain.com)');
  const resQuery = await fetch('http://localhost:3000/downloads/PrintQR-Agent.zip?origin=https://customdomain.com');
  const bufQuery = Buffer.from(await resQuery.arrayBuffer());
  const tmpQuery = path.join(os.tmpdir(), 'test_agent_query.zip');
  fs.writeFileSync(tmpQuery, bufQuery);

  const tmpExtractQuery = path.join(os.tmpdir(), 'test_agent_query_dir');
  fs.rmSync(tmpExtractQuery, { recursive: true, force: true });
  fs.mkdirSync(tmpExtractQuery, { recursive: true });
  execSync(`tar -xf "${tmpQuery}" -C "${tmpExtractQuery}"`);

  const serverUrlQuery = fs.readFileSync(path.join(tmpExtractQuery, 'PrintQR-Agent', 'server_url.txt'), 'utf8').trim();
  console.log('   ✓ Extracted server_url.txt for query:', serverUrlQuery);
  if (serverUrlQuery !== 'https://customdomain.com') throw new Error('Expected https://customdomain.com, got ' + serverUrlQuery);

  // Clean up temp files
  [tmpLocal, tmpRender, tmpQuery].forEach(f => fs.rmSync(f, { force: true }));
  [tmpExtractLocal, tmpExtractRender, tmpExtractQuery].forEach(d => fs.rmSync(d, { recursive: true, force: true }));

  console.log('\n--- ALL DOWNLOAD & AUTO-FILL TESTS PASSED! ---');
}

testDownload().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
