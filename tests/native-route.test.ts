import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { nativeRoute } from '../src/native-route.ts';
import { buildCommand } from '../src/commands.ts';
import { candidate } from './helpers.ts';

for (const tool of ['codex', 'pi', 'agy'] as const) {
  test(`${tool} route identity matches effective native selectors`, () => {
    const value = candidate({ tool, provider: 'one', model: 'model-example' });
    const route = nativeRoute(value);
    assert.equal(route.provider_selection, tool === 'agy' ? 'existing_settings' : 'explicit_flag');
    assert.equal(buildCommand(value, 'low').provider_selection, route.provider_selection);
    assert.equal(route.identity, JSON.stringify([tool, tool === 'agy' ? null : 'one', 'model-example']));
    assert.notEqual(route.identity, nativeRoute({ ...value, model: 'other-model' }).identity);
    if (tool === 'agy') {
      assert.equal(route.identity, nativeRoute({ ...value, provider: 'two' }).identity);
    } else {
      assert.notEqual(route.identity, nativeRoute({ ...value, provider: 'two' }).identity);
    }
  });
}

test('native identity distinguishes tools without interpreting billing or ranking metadata', () => {
  const value = candidate();
  assert.notEqual(nativeRoute(value).identity, nativeRoute({ ...value, tool: 'pi' }).identity);
  const alias = {
    ...value,
    id: 'another-id',
    cost: 42,
    capabilities: 'Different description',
    thinking_levels: [{ id: 'high', description: 'Different effort' }],
    billing: 'api',
  };
  assert.equal(nativeRoute(value).identity, nativeRoute(alias).identity);
});

test('native identity uses an unambiguous tuple for selector text', () => {
  const value = candidate({ provider: 'a/b', model: 'c' });
  assert.notEqual(nativeRoute(value).identity, nativeRoute({ ...value, provider: 'a', model: 'b/c' }).identity);
});
