import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { LimitError, MAX_JSON_BYTES } from '../dist/src/limits.js';
import { readBoundedUtf8, readFileText } from '../dist/src/io.js';

test('bounded reader accepts exactly the byte cap and decodes UTF-8 split across chunks', async () => {
  const exact = await readBoundedUtf8(Readable.from([Buffer.from('é'.repeat(MAX_JSON_BYTES / 2))]));
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_JSON_BYTES);
  assert.equal(await readBoundedUtf8(Readable.from([Buffer.from([0xe2]), Buffer.from([0x82, 0xac])])), '€');
});

test('bounded reader destroys a stream before retaining bytes past the cap', async () => {
  const stream = Readable.from([Buffer.alloc(MAX_JSON_BYTES), Buffer.from('x')]);
  await assert.rejects(readBoundedUtf8(stream), (error) => error instanceof LimitError);
  assert.equal(stream.destroyed, true);
});

test('bounded reader rejects malformed UTF-8 instead of replacing bytes', async () => {
  await assert.rejects(readBoundedUtf8(Readable.from([Buffer.from([0xc3, 0x28])])));
});

test('bounded reader rejects aborted streams and settles only once', async () => {
  const stream = new PassThrough();
  let settlements = 0;
  const pending = readBoundedUtf8(stream).then(
    (value) => {
      settlements++;
      return value;
    },
    (error) => {
      settlements++;
      throw error;
    },
  );
  stream.emit('aborted');
  await assert.rejects(pending);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settlements, 1);
  assert.equal(stream.destroyed, true);
});

test('bounded reader rejects a prematurely closed stream', async () => {
  const stream = new PassThrough();
  const pending = readBoundedUtf8(stream);
  stream.destroy();
  await assert.rejects(pending);
});

test('explicit file reader uses the bounded UTF-8 reader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-steward-io-'));
  const path = join(directory, 'selected-input.json');
  try {
    const content = '{"text":"héllo"}';
    await writeFile(path, content);
    assert.equal(await readFileText(path), content);
    await writeFile(path, 'x'.repeat(MAX_JSON_BYTES + 1));
    await assert.rejects(readFileText(path), (error) => error instanceof LimitError);
    assert.equal((await readFile(path, 'utf8')).length, MAX_JSON_BYTES + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
