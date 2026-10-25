const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const config = JSON.parse(readFileSync(path.join(__dirname, '../apps/mobile/app.json'), 'utf8')).expo;
const full = (name) => name.startsWith('android.permission.') ? name : 'android.permission.' + name;
const broad = ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO'];

test('infrequent attachment use never explicitly requests broad photo/video access', () => {
  const requested = new Set(config.android.permissions.map(full));
  for (const name of broad) assert.equal(requested.has(name), false, `${name} must not be requested`);
});
test('blocks transitive broad media permissions without removing camera/audio/notifications', () => {
  const blocked = new Set((config.android.blockedPermissions || []).map(full));
  for (const name of broad) assert.equal(blocked.has(name), true, `${name} must be blocked`);
  for (const name of ['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS']) {
    assert.equal(config.android.permissions.includes(name), true);
    assert.equal(blocked.has(full(name)), false);
  }
});
