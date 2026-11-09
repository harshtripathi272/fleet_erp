// #121: the only owner forgets their password on a copy with no e-mail server.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { applyOwnerPasswordReset } from '../src/modules/auth/auth.service.js';
import { User } from '../src/modules/users/user.model.js';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole } from './helpers.js';

const signIn = (email: string, password: string) => api().post('/api/v1/auth/login').send({ email, password });

before(startDatabase);
after(stopDatabase);

describe('a locked-out owner', () => {
  test('whoever runs the copy can get them back in, once, and no one else through it', async () => {
    await resetDatabase();
    const owner = await signUp('Owner');
    const staff = await userWithRole(owner, 'operations');
    // Too many wrong tries have also locked the account.
    await User.updateOne({ _id: owner.userId }, { $set: { lockedUntil: new Date(Date.now() + 3600_000), failedLoginCount: 9 } });
    assert.notEqual((await signIn(owner.email, 'Passw0rd!')).status, 200);

    assert.deepEqual(await applyOwnerPasswordReset(undefined, owner.email), { applied: false }, 'nothing happens with no variable');
    assert.equal((await applyOwnerPasswordReset('Back-in-123', staff.email)).reason, 'no-owner', 'only an Owner, whatever OWNER_EMAIL says');
    assert.equal((await signIn(staff.email, 'Back-in-123')).status, 401);

    assert.equal((await applyOwnerPasswordReset('Back-in-123', owner.email)).applied, true);
    await api().get('/api/v1/auth/me').set(bearer(owner)).expect(401);
    const back = await signIn(owner.email, 'Back-in-123');
    assert.equal(back.status, 200, 'the lock is gone too');
    assert.equal((await User.findById(owner.userId).lean())?.mustChangePassword, true);

    // They choose their own, and the variable is still set at the next restart.
    await api().post('/api/v1/auth/change-password').set(bearer({ token: back.body.data.accessToken })).send({ currentPassword: 'Back-in-123', newPassword: 'Their-own-456' }).expect((r) => { assert.ok(r.status < 300, JSON.stringify(r.body)); });
    assert.equal((await applyOwnerPasswordReset('Back-in-123', owner.email)).reason, 'already-used');
    assert.equal((await signIn(owner.email, 'Their-own-456')).status, 200, 'a restart cannot undo the password they chose');
  });

  test('the sign-in screen is told when no reset link can be sent', async () => {
    const options = (await api().get('/api/v1/auth/options').expect(200)).body.data as { mail: boolean };
    assert.equal(typeof options.mail, 'boolean');
  });
});
