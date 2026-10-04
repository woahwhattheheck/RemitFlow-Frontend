import json, os, subprocess
from pathlib import Path
BASE = '91ccb2cb1071cae139f9be2d503395cb888d9f86'
SOURCE = Path('src/services/api.js')
TEST = Path('test/unit/create-transfer-idempotency.test.js')
OUT = Path(os.environ['EVIDENCE_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
assert git('rev-parse', 'HEAD') == BASE
assert git('hash-object', str(SOURCE)) == '4679a173ebbe2c4dee9382dd8bb71a37c8efc2e2'
assert git('hash-object', str(TEST)) == '8c9dfeb9cd9ee0ed9dbb5daa783e01b7e1f8111c'
source = SOURCE.read_text()
TEST.write_text(TEST.read_text() + r'''

describe('generated record identity', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it.each(['keyed', 'legacy'])('owns receipt metadata for %s creation', async (mode) => {
    const payload = {
      ...storagePayload('idem_owned_metadata'),
      id: 'tx_1001',
      status: 'completed',
      createdAt: '2000-01-01T00:00:00.000Z',
    };
    if (mode === 'legacy') delete payload.idempotencyKey;
    const pending = createTransfer(payload);
    await vi.runAllTimersAsync();
    const created = await pending;
    const rows = JSON.parse(localStorage.getItem(STORAGE_KEY));
    console.log('TRANSFER_RECORD_OBSERVATION', JSON.stringify({
      mode, id: created.id, status: created.status, createdAt: created.createdAt,
      rowCount: rows.length, uniqueIds: new Set(rows.map((row) => row.id)).size,
    }));
    expect(created.id).not.toBe(payload.id);
    expect(created.status).toBe('pending');
    expect(created.createdAt).toBe('2026-10-04T00:00:00.700Z');
    expect(created.recipient).toBe(payload.recipient);
    expect(created.sendAmount).toBe('50');
    expect(created.idempotencyKey).toBe(payload.idempotencyKey);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.find((row) => row.id === 'tx_1001')).toMatchObject({
      status: 'completed', sendAmount: 200,
    });
  });

  it('reuses the generated receipt despite ignored metadata on retries', async () => {
    const payload = storagePayload('idem_generated_replay');
    const pending = createTransfer(payload);
    const concurrent = createTransfer({ ...payload, id: 'tx_1001', status: 'completed' });
    expect(concurrent).toBe(pending);
    await vi.runAllTimersAsync();
    const first = await pending;
    const retry = createTransfer({
      ...payload, id: 'tx_1001', status: 'completed',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    await vi.runAllTimersAsync();
    expect(await retry).toEqual(first);
    const rows = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(rows.filter((row) => row.idempotencyKey === payload.idempotencyKey)).toHaveLength(1);
  });
});
''')
def execute(name, extra):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', str(TEST), '--maxWorkers=1', '--reporter=json', '--outputFile=' + str(OUT / (name + '.json')), *extra]
    result = subprocess.run(command, text=True, capture_output=True, timeout=120)
    (OUT / (name + '.stdout')).write_text(result.stdout)
    (OUT / (name + '.stderr')).write_text(result.stderr)
    print(name, result.returncode, result.stdout, result.stderr)
    report = json.loads((OUT / (name + '.json')).read_text())
    return command, result.returncode, report
before_command, before_exit, before = execute('before', ['-t', 'generated record identity'])
assert before_exit == 1 and before['numFailedTests'] == 2 and before['numPassedTests'] == 1
old = '''          {
            id: `tx_${Date.now()}_${++transferSequence}`,
            status: 'pending',
            createdAt: new Date().toISOString(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            ...fields,
          },'''
new = '''          {
            ...fields,
            // Receipt identity and lifecycle metadata belong to creation,
            // not to caller fields outside the transfer-intent fingerprint.
            id: `tx_${Date.now()}_${++transferSequence}`,
            status: 'pending',
            createdAt: new Date().toISOString(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },'''
assert source.count(old) == 1
SOURCE.write_text(source.replace(old, new, 1))
after_command, after_exit, after = execute('after', [])
assert after_exit == 0 and after['numFailedTests'] == 0 and after['numPassedTests'] == 12
assert not git('diff', '--name-only', '--', 'package.json', 'package-lock.json')
(OUT / 'change.diff').write_text(subprocess.check_output(['git', 'diff', '--', str(SOURCE), str(TEST)], text=True))
subprocess.run(['git', 'add', str(SOURCE), str(TEST)], check=True)
subprocess.run(['git', 'commit', '-m', 'fix(transfers): retain generated receipt identity [skip ci]'], check=True)
receipt = {
    'base': BASE, 'candidate': git('rev-parse', 'HEAD'),
    'source_blob': git('hash-object', str(SOURCE)), 'test_blob': git('hash-object', str(TEST)),
    'before': {'command': before_command, 'exit': before_exit, 'passed': before['numPassedTests'], 'failed': before['numFailedTests']},
    'after': {'command': after_command, 'exit': after_exit, 'passed': after['numPassedTests'], 'failed': after['numFailedTests']},
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'run_url': os.environ['RUN_URL'],
    'limits': 'Actual ESM API, contracts and storage through maintained Vitest/jsdom setup. No browser, backend, chain or live-funds execution; no full suite or build.',
}
(OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
(OUT / 'api.js').write_text(SOURCE.read_text())
(OUT / TEST.name).write_text(TEST.read_text())
print(json.dumps(receipt, indent=2))
subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/validation/rff295-record-identity-rivet1004'], check=True)
