/* global describe, beforeAll, beforeEach, it, expect, spyOn */
const request = require('supertest')
const nock = require('nock')
const httpSignature = require('http-signature')
const merge = require('deepmerge')

const activity = {
  '@context': [
    'https://www.w3.org/ns/activitystreams',
    'https://w3id.org/security/v1'
  ],
  type: 'Create',
  to: 'https://ignore.com/u/ignored',
  actor: 'https://localhost/u/test',
  object: {
    type: 'Note',
    attributedTo: 'https://localhost/u/test',
    to: 'https://ignore.com/u/ignored',
    content: 'Say, did you finish reading that book I lent you?'
  }
}

const activityNormalized = {
  type: 'Create',
  actor: [
    'https://localhost/u/test'
  ],
  object: [
    {
      type: 'Note',
      attributedTo: [
        'https://localhost/u/test'
      ],
      content: [
        'Say, did you finish reading that book I lent you?'
      ],
      to: [
        'https://ignore.com/u/ignored'
      ]
    }
  ],
  to: [
    'https://ignore.com/u/ignored'
  ]
}

describe('outbox', function () {
  let testUser
  let app
  let apex
  let client
  beforeAll(async function () {
    const init = await global.initApex()
    testUser = init.testUser
    app = init.app
    apex = init.apex
    client = init.client
    app.route('/outbox/:actor')
      .get(apex.net.outbox.get)
      .post(apex.net.outbox.post)
  })
  beforeEach(function () {
    // don't let failed deliveries pollute later tests
    spyOn(apex.store, 'deliveryRequeue').and.resolveTo(undefined)
    return global.resetDb(apex, client, testUser)
  })
  describe('post', function () {
    // validators jsonld
    it('ignores invalid body types', function (done) {
      request(app)
        .post('/outbox/test')
        .send({})
        .expect(404, done)
    })
    // validators activity
    it('errors invalid activities', function (done) {
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send({ actor: 'bob', '@context': 'https://www.w3.org/ns/activitystreams' })
        .expect(400, 'Invalid activity', done)
    })
    // activity getTargetActor
    it('errors on unknown actor', function (done) {
      request(app)
        .post('/outbox/noone')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(404, '\'noone\' not found on this instance', done)
    })
    // activity save
    it('saves activity in stream', function (done) {
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(200)
        .then(() => {
          return apex.store.db
            .collection('streams')
            .findOne({ actor: 'https://localhost/u/test' })
        })
        .then(act => {
          expect(act._meta.collection).toEqual(['https://localhost/outbox/test'])
          delete act._meta
          delete act._id
          delete act.id
          delete act.object[0].id
          expect(act).toEqual(activityNormalized)
          done()
        })
        .catch(done)
    })
    it('saves object from activity', function (done) {
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(200)
        .then(() => {
          return apex.store.db
            .collection('objects')
            .findOne({ attributedTo: ['https://localhost/u/test'] })
        })
        .then(o => {
          delete o._meta
          delete o._id
          expect(o.id).not.toBeFalsy()
          delete o.id
          expect(o).toEqual(activityNormalized.object[0])
          done()
        })
        .catch(done)
    })
    it('wraps a bare object in a create activity', function (done) {
      const bareObj = merge({}, activity.object)
      bareObj['@context'] = 'https://www.w3.org/ns/activitystreams'
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(bareObj)
        .expect(200)
        .then(() => {
          return apex.store.db
            .collection('streams')
            .findOne({ actor: 'https://localhost/u/test' })
        })
        .then(act => {
          expect(act.type).toBe('Create')
          delete act.object[0].id
          expect(act.object[0]).toEqual(activityNormalized.object[0])
          done()
        })
        .catch(done)
    })
    it('delivers messages to federation targets', function (done) {
      const act = merge({}, activity)
      act.to = act.object.to = 'https://mocked.com/user/mocked'
      nock('https://mocked.com')
        .get('/user/mocked')
        .reply(200, { id: 'https://mocked.com/user/mocked', inbox: 'https://mocked.com/inbox/mocked' })
      nock('https://mocked.com').post('/inbox/mocked')
        .reply(200)
        .on('request', (req, interceptor, body) => {
          // correctly formed activity sent
          const sentActivity = JSON.parse(body)
          delete sentActivity.id
          delete sentActivity.object.id
          expect(sentActivity).toEqual(act)
          // valid signature
          req.originalUrl = req.path
          const sigHead = httpSignature.parse(req)
          // mastodon 3.2.1 requirement
          expect(sigHead.params.headers).toContain('digest')
          expect(httpSignature.verifySignature(sigHead, testUser.publicKey[0].publicKeyPem[0])).toBeTruthy()
          done()
        })
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(act)
        .expect(200)
        .end(function (err) {
          if (err) throw err
        })
    })
    it('does not deliver to blocked actors', async function (done) {
      const deliverSpy = spyOn(apex, 'deliver')
      const act = merge({}, activity)
      act.to = act.object.to = 'https://localhost/u/blocked'
      const block = merge({}, activityNormalized)
      block.type = 'Block'
      block.object = ['https://localhost/u/blocked']
      block._meta = { collection: [apex.utils.nameToBlockedIRI(testUser.preferredUsername)] }
      await apex.store.saveActivity(block)
      app.once('apex-outbox', msg => {
        expect(deliverSpy).not.toHaveBeenCalled()
        done()
      })
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(act)
        .expect(200)
        .end(function (err) {
          if (err) throw err
        })
    })
    // activity side effects
    it('fires create event', function (done) {
      app.once('apex-outbox', msg => {
        expect(msg.actor).toEqual(testUser)
        delete msg.activity.id
        delete msg.object.id
        const exp = merge({ _meta: { collection: ['https://localhost/outbox/test'] } }, activityNormalized)
        expect(msg.activity).toEqual(exp)
        expect(msg.object).toEqual(activityNormalized.object[0])
        done()
      })
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(200)
        .end(err => { if (err) done(err) })
    })
    describe('undo', function () {
      let undo
      let undone
      beforeEach(function () {
        undone = merge({}, activityNormalized)
        undone.id = apex.utils.activityIdToIRI()
        undo = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          type: 'Undo',
          to: ['https://ignore.com/bob'],
          actor: 'https://localhost/u/test',
          object: undone.id
        }
      })
      it('fires undo event', async function (done) {
        await apex.store.saveActivity(undone)
        app.once('apex-outbox', () => {
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(undo)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('rejects undo with owner mismatch', async function (done) {
        undone.actor = ['https://ignore.com/bob']
        await apex.store.saveActivity(undone)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(undo)
          .expect(403, done)
      })
      it('removes undone activity', async function (done) {
        await apex.store.saveActivity(undone)
        await request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(undo)
          .expect(200)
        const result = await apex.store.getActivity(undone.id)
        expect(result).toBeFalsy()
        done()
      })
      it('publishes related collection updates')
    })
    describe('update', function () {
      let sourceObj
      let updatedObj
      let expectedObj
      let update
      beforeEach(async function () {
        sourceObj = merge({ id: apex.utils.objectIdToIRI() }, activityNormalized.object[0])
        // partial object for partial update
        updatedObj = { id: sourceObj.id, content: ['updated'] }
        expectedObj = merge({}, sourceObj)
        expectedObj.content = updatedObj.content
        await apex.store.db.collection('objects')
          .insertOne(sourceObj, { forceServerObjectId: true })
        update = await apex
          .buildActivity('Update', 'https://localhost/u/test', sourceObj.to, { object: updatedObj })
      })
      it('updates target object', async function () {
        await request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(update)
          .expect(200)
        const result = await apex.store.db.collection('objects')
          .findOne({ id: sourceObj.id })
        delete result._id
        expect(result).toEqual(expectedObj)
      })
      it('updates activities containing object', async function () {
        const db = apex.store.db
        await db.collection('streams').insertMany([
          await apex.buildActivity('Create', 'https://localhost/u/test', sourceObj.to, { object: sourceObj }),
          await apex.buildActivity('Create', 'https://localhost/u/test', sourceObj.to, { object: sourceObj })
        ])
        await request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(update)
          .expect(200)
        const activities = await db.collection('streams').find({ type: 'Create', 'object.0.id': sourceObj.id }).toArray()
        expect(activities[0].object[0]).toEqual(expectedObj)
        expect(activities[1].object[0]).toEqual(expectedObj)
      })
      it('adds updated object recipients to audience')
      it('federates whole updated object', async function (done) {
        update.to = ['https://mocked.com/user/mocked']
        update.object[0].to = ['https://mocked.com/user/mocked']
        nock('https://mocked.com')
          .get('/user/mocked')
          .reply(200, { id: 'https://mocked.com/user/mocked', inbox: 'https://mocked.com/inbox/mocked' })
        nock('https://mocked.com').post('/inbox/mocked')
          .reply(200)
          .on('request', (req, interceptor, body) => {
            const sentActivity = JSON.parse(body)
            expect(sentActivity.object).toEqual({
              id: sourceObj.id,
              type: 'Note',
              attributedTo: 'https://localhost/u/test',
              to: 'https://mocked.com/user/mocked',
              content: 'updated'
            })
            done()
          })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(update)
          .expect(200)
          .end(function (err) {
            if (err) throw err
          })
      })
      it('does not leak private keys', async function (done) {
        update.to = ['https://mocked.com/user/mocked']
        update.object = [{
          id: testUser.id,
          name: 'New display name'
        }]
        nock('https://mocked.com')
          .get('/user/mocked')
          .reply(200, { id: 'https://mocked.com/user/mocked', inbox: 'https://mocked.com/inbox/mocked' })
        nock('https://mocked.com').post('/inbox/mocked')
          .reply(200)
          .on('request', async (req, interceptor, body) => {
            const sentActivity = JSON.parse(body)
            const standard = await apex.toJSONLD(merge({}, testUser))
            delete standard._meta
            delete standard._local
            delete standard._id
            delete standard['@context']
            standard.name = 'New display name'
            expect(sentActivity.object).toEqual(standard)
            done()
          })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(update)
          .expect(200)
          .end(function (err) {
            if (err) throw err
          })
      })
    })
    describe('accept', function () {
      let follow
      let accept
      beforeEach(function () {
        follow = merge({ _meta: { collection: testUser.inbox } }, activityNormalized)
        follow.object = [testUser.id]
        follow.type = 'Follow'
        follow.actor = ['https://ignore.com/u/ignored']
        follow.to = [testUser.id]
        follow.id = apex.utils.activityIdToIRI()
        accept = merge({}, activity)
        accept.object = follow.id
        accept.type = 'Accept'
      })
      it('fires accept event', async function (done) {
        await apex.store.saveActivity(follow)
        app.once('apex-outbox', msg => {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          const exp = merge({ _meta: { collection: ['https://localhost/outbox/test'] } }, activityNormalized)
          exp.type = 'Accept'
          exp.object = [follow.id]
          expect(msg.activity).toEqual(exp)
          follow._meta.collection.push(testUser.followers[0])
          expect(msg.object).toEqual(follow)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(accept)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('publishes collection update', async function (done) {
        const mockedUser = 'https://mocked.com/user/mocked'
        nock('https://mocked.com')
          .get('/user/mocked')
          .reply(200, { id: mockedUser, inbox: 'https://mocked.com/inbox/mocked' })
        nock('https://mocked.com')
          .post('/inbox/mocked').reply(200) // accept activity delivery
          .post('/inbox/mocked').reply(200)
          .on('request', (req, interceptor, body) => {
            // correctly formed activity sent
            const sentActivity = JSON.parse(body)
            if (sentActivity.type === 'Accept') return
            expect(sentActivity.id).toContain('https://localhost')
            delete sentActivity.id
            delete sentActivity.likes
            delete sentActivity.shares
            expect(new Date(sentActivity.published).toString()).not.toBe('Invalid Date')
            delete sentActivity.published
            expect(sentActivity).toEqual({
              '@context': apex.context,
              type: 'Update',
              actor: testUser.id,
              to: testUser.followers[0],
              object: {
                id: testUser.followers[0],
                type: 'OrderedCollection',
                totalItems: 1,
                first: 'https://localhost/followers/test?page=true'
              }
            })
            done()
          })
        follow.actor = [mockedUser]
        accept.to = mockedUser
        await apex.store.saveActivity(follow)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(accept)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('reject', function () {
      let follow
      let reject
      let rejected
      beforeEach(function () {
        follow = merge({ _meta: { collection: [testUser.inbox[0], testUser.followers[0]] } }, activityNormalized)
        follow.object = [testUser.id]
        follow.type = 'Follow'
        follow.actor = ['https://ignore.com/u/ignored']
        follow.to = [testUser.id]
        follow.id = apex.utils.activityIdToIRI()
        reject = merge({}, activity)
        reject.object = follow.id
        reject.type = 'Reject'
        rejected = apex.utils.nameToRejectedIRI(testUser.preferredUsername)
      })
      it('fires reject event', async function (done) {
        await apex.store.saveActivity(follow)
        app.once('apex-outbox', msg => {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          const exp = merge({ _meta: { collection: testUser.outbox } }, activityNormalized)
          exp.type = 'Reject'
          exp.object = [follow.id]
          expect(msg.activity).toEqual(exp)
          // removed from followers
          follow._meta.collection = [testUser.inbox[0], rejected]
          expect(msg.object).toEqual(follow)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(reject)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('publishes collection update', async function (done) {
        const mockedUser = 'https://mocked.com/user/mocked'
        nock('https://mocked.com')
          .get('/user/mocked')
          .reply(200, { id: mockedUser, inbox: 'https://mocked.com/inbox/mocked' })
        nock('https://mocked.com')
          .post('/inbox/mocked').reply(200)
          .on('request', (req, interceptor, body) => {
            // correctly formed activity sent
            const sentActivity = JSON.parse(body)
            if (sentActivity.type === 'Reject') return
            expect(sentActivity.id).toContain('https://localhost')
            delete sentActivity.id
            delete sentActivity.likes
            delete sentActivity.shares
            expect(new Date(sentActivity.published).toString()).not.toBe('Invalid Date')
            delete sentActivity.published
            expect(sentActivity).toEqual({
              '@context': apex.context,
              type: 'Update',
              actor: testUser.id,
              to: testUser.followers[0],
              object: {
                id: testUser.followers[0],
                type: 'OrderedCollection',
                totalItems: 1,
                first: 'https://localhost/followers/test?page=true'
              }
            })
            done()
          })
        await apex.store.saveActivity(follow)
        // actor needs one follower remaining to deliver collection udpate
        const otherFollow = merge({}, follow)
        otherFollow.id = apex.utils.activityIdToIRI()
        otherFollow.actor = [mockedUser]
        await apex.store.saveActivity(otherFollow)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(reject)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('delete', function () {
      let toDelete
      let deleteAct
      beforeEach(function () {
        toDelete = merge({}, activityNormalized.object[0])
        toDelete.id = 'https://localhost/o/2349-ssdfds-34tdgf'
        deleteAct = merge({}, activity)
        deleteAct.type = 'Delete'
        deleteAct.object = 'https://localhost/o/2349-ssdfds-34tdgf'
      })
      it('fires delete event', async function (done) {
        await apex.store.saveObject(toDelete)
        app.once('apex-outbox', function (msg) {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          expect(msg.activity).toEqual({
            _meta: { collection: ['https://localhost/outbox/test'] },
            type: 'Delete',
            actor: ['https://localhost/u/test'],
            object: ['https://localhost/o/2349-ssdfds-34tdgf'],
            to: [
              'https://ignore.com/u/ignored'
            ]
          })
          expect(msg.object).toEqual(toDelete)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(deleteAct)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('rejects if actor not owner', async function (done) {
        toDelete.attributedTo = ['https://localhost/u/sally']
        await apex.store.saveObject(toDelete)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(deleteAct)
          .expect(403, done)
      })
      it('replaces object in store with tombstone', async function (done) {
        await apex.store.saveObject(toDelete)
        app.once('apex-outbox', async function () {
          const tomb = await apex.store.getObject(toDelete.id)
          expect(new Date(tomb.deleted).toString()).not.toBe('Invalid Date')
          delete tomb.deleted
          delete tomb.published
          delete tomb.updated
          expect(tomb).toEqual({
            id: toDelete.id,
            type: 'Tombstone'
          })
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(deleteAct)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('replaces object in streams with tombstone', async function (done) {
        await apex.store.saveObject(toDelete)
        const original = merge({}, activityNormalized)
        original.id = apex.utils.activityIdToIRI()
        original.object[0].id = toDelete.id
        await apex.store.saveActivity(original)
        app.once('apex-outbox', async () => {
          const tomb = (await apex.store.getActivity(original.id)).object[0]
          expect(new Date(tomb.deleted).toString()).not.toBe('Invalid Date')
          delete tomb.deleted
          delete tomb.updated
          delete tomb.published
          expect(tomb).toEqual({
            id: toDelete.id,
            type: 'Tombstone'
          })
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(deleteAct)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('announce', function () {
      let announceable
      let announce
      beforeEach(function () {
        announceable = merge({}, activityNormalized)
        announceable.id = apex.utils.activityIdToIRI()
        announce = merge({}, activity)
        announce.type = 'Announce'
        announce.object = announceable.id
      })
      it('does not denormalize object in delivered activity', async function (done) {
        await apex.store.saveActivity(announceable)
        spyOn(apex, 'addToOutbox')
        app.once('apex-outbox', function () {
          expect(apex.addToOutbox.calls.argsFor(0)[1].object)
            .toEqual([announceable.id])
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(announce)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('like', function () {
      let likeable
      let like
      beforeEach(function () {
        likeable = merge({}, activityNormalized)
        likeable.id = apex.utils.activityIdToIRI()
        like = merge({}, activity)
        like.type = 'Like'
        like.object = likeable.id
      })
      it('fires like event', async function (done) {
        await apex.store.saveActivity(likeable)
        app.once('apex-outbox', function (msg) {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          expect(msg.activity).toEqual({
            _meta: { collection: [testUser.outbox[0], testUser.liked[0]] },
            type: 'Like',
            actor: ['https://localhost/u/test'],
            object: [likeable],
            to: ['https://ignore.com/u/ignored']
          })
          expect(msg.object).toEqual(likeable)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(like)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('adds to liked collection', async function (done) {
        await apex.store.saveActivity(likeable)
        app.once('apex-outbox', async function (msg) {
          const liked = await apex.getLiked(testUser, Infinity)
          expect(liked.orderedItems).toContain(likeable.id)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(like)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('rejects if no object', function (done) {
        delete like.object
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(like)
          .expect(400, done)
      })
      it('publishes collection update', async function (done) {
        const mockedUser = 'https://mocked.com/user/mocked'
        nock('https://mocked.com')
          .post('/inbox/mocked').reply(200) // like activity delivery
          .post('/inbox/mocked').reply(200)
          .on('request', (req, interceptor, body) => {
            // correctly formed activity sent
            const sentActivity = JSON.parse(body)
            if (sentActivity.type === 'Like') return
            expect(sentActivity.id).toContain('https://localhost')
            delete sentActivity.id
            delete sentActivity.likes
            delete sentActivity.shares
            expect(new Date(sentActivity.published).toString()).not.toBe('Invalid Date')
            delete sentActivity.published
            expect(sentActivity).toEqual({
              '@context': apex.context,
              type: 'Update',
              actor: testUser.id,
              to: testUser.followers[0],
              object: {
                id: testUser.liked[0],
                type: 'OrderedCollection',
                totalItems: 1,
                first: 'https://localhost/liked/test?page=true'
              }
            })
            done()
          })
        likeable.actor = [mockedUser]
        like.to = mockedUser
        spyOn(apex, 'address').and.callFake(async () => ['https://mocked.com/inbox/mocked'])
        await apex.store.saveActivity(likeable)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(like)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('add', function () {
      let collection
      let addable
      let add
      beforeEach(function () {
        collection = `${testUser.id}/c/test`
        addable = merge({}, activityNormalized)
        addable.id = apex.utils.activityIdToIRI()
        addable.object[0].id = apex.utils.objectIdToIRI()
        add = merge({}, activity)
        add.type = 'Add'
        add.object = addable
        add.target = collection
      })
      it('fires add event', async function (done) {
        await apex.store.saveActivity(addable)
        app.once('apex-outbox', function (msg) {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          expect(msg.activity).toEqual({
            _meta: { collection: ['https://localhost/outbox/test'] },
            type: 'Add',
            actor: ['https://localhost/u/test'],
            object: [addable],
            target: [collection],
            to: ['https://ignore.com/u/ignored']
          })
          addable._meta = { collection: [collection] }
          expect(msg.object).toEqual(addable)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(add)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('rejects missing target', async function (done) {
        delete add.target
        await apex.store.saveActivity(addable)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(add)
          .expect(400, done)
      })
      it('rejects un-owned target', async function (done) {
        add.target = 'https://localhost/u/bob/bobs-stuff'
        await apex.store.saveActivity(addable)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(add)
          .expect(403, done)
      })
      it('adds to collection', async function (done) {
        await apex.store.saveActivity(addable)
        app.once('apex-outbox', async function (msg) {
          const added = await apex.getAdded(testUser, 'test', Infinity)
          delete added.orderedItems[0]._id
          expect(added.orderedItems[0]).toEqual(addable)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(add)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('remove', function () {
      let collection
      let added
      let remove
      beforeEach(function () {
        collection = `${testUser.id}/c/test`
        added = merge({}, activityNormalized)
        added._meta = { collection: [collection] }
        added.id = apex.utils.activityIdToIRI()
        added.object[0].id = apex.utils.objectIdToIRI()
        remove = merge({}, activity)
        remove.type = 'Remove'
        remove.object = added.id
        remove.target = collection
      })
      it('fires remove event', async function (done) {
        await apex.store.saveActivity(added)
        app.once('apex-outbox', function (msg) {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          expect(msg.activity).toEqual({
            _meta: { collection: ['https://localhost/outbox/test'] },
            type: 'Remove',
            actor: ['https://localhost/u/test'],
            object: [added.id],
            target: [collection],
            to: ['https://ignore.com/u/ignored']
          })
          added._meta.collection = []
          expect(msg.object).toEqual(added)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(remove)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('rejects missing target', async function (done) {
        delete remove.target
        await apex.store.saveActivity(added)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(remove)
          .expect(400, done)
      })
      it('rejects un-owned target', async function (done) {
        remove.target = 'https://localhost/u/bob/bobs-stuff'
        await apex.store.saveActivity(added)
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(remove)
          .expect(403, done)
      })
      it('removes from collection', async function (done) {
        await apex.store.saveActivity(added)
        const addedCol = await apex.getAdded(testUser, 'test')
        expect(addedCol.totalItems).toEqual([1])
        app.once('apex-outbox', async function (msg) {
          const addedCol = await apex.getAdded(testUser, 'test', Infinity)
          expect(addedCol.orderedItems).toEqual([])
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(remove)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    describe('block', function () {
      let block
      beforeEach(function () {
        block = merge({}, activity)
        block.type = 'Block'
        block.to = null
        block.object = { id: 'https://ignore.com/bob', type: 'Actor' }
      })
      it('fires block event', async function (done) {
        app.once('apex-outbox', function (msg) {
          expect(msg.actor).toEqual(testUser)
          delete msg.activity.id
          expect(msg.activity).toEqual({
            _meta: { collection: [apex.utils.nameToBlockedIRI(testUser.preferredUsername)] },
            type: 'Block',
            actor: [testUser.id],
            object: [block.object]
          })
          expect(msg.object).toEqual(block.object)
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(block)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
      it('adds to blocklist', async function (done) {
        app.once('apex-outbox', async function (msg) {
          const blockList = await apex.getBlocked(testUser, Infinity)
          expect(blockList.orderedItems).toEqual([block.object.id])
          done()
        })
        request(app)
          .post('/outbox/test')
          .set('Content-Type', 'application/activity+json')
          .send(block)
          .expect(200)
          .end(err => { if (err) done(err) })
      })
    })
    it('fires other activity event', function (done) {
      const arriveAct = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Arrive',
        to: ['https://ignore.com/u/ignored'],
        actor: 'https://localhost/u/test',
        location: {
          type: 'Place',
          name: 'Here'
        }
      }
      app.once('apex-outbox', msg => {
        expect(msg.actor).toEqual(testUser)
        delete msg.activity.id
        expect(msg.activity).toEqual({
          _meta: { collection: ['https://localhost/outbox/test'] },
          type: 'Arrive',
          to: ['https://ignore.com/u/ignored'],
          actor: ['https://localhost/u/test'],
          location: [{
            type: 'Place',
            name: ['Here']
          }]
        })
        done()
      })
      request(app)
        .post('/outbox/test')
        .set('Content-Type', 'application/activity+json')
        .send(arriveAct)
        .expect(200)
        .end(err => { if (err) done(err) })
    })
  })
  describe('get', function () {
    const fakeId = 'https://localhost/s/a29a6843-9feb-4c74-a7f7-081b9c9201d3'
    const fakeOId = 'https://localhost/o/a29a6843-9feb-4c74-a7f7-081b9c9201d3'
    let outbox
    beforeEach(async function () {
      outbox = [1, 2, 3].map(i => {
        const a = Object.assign({}, activity, { id: `${fakeId}${i}`, _meta: { collection: ['https://localhost/outbox/test'] } })
        a.object = Object.assign({}, a.object, { id: `${fakeOId}${i}` })
        return a
      })
      await apex.store.db
        .collection('streams')
        .insertMany(outbox)
    })
    it('returns outbox as ordered collection', (done) => {
      const outboxCollection = {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: 'https://localhost/outbox/test',
        type: 'OrderedCollection',
        totalItems: 3,
        first: 'https://localhost/outbox/test?page=true'
      }
      request(app)
        .get('/outbox/test')
        .set('Accept', 'application/activity+json')
        .expect(200)
        .end((err, res) => {
          expect(res.body).toEqual(outboxCollection)
          done(err)
        })
    })
    it('returns outbox page as ordered collection page', (done) => {
      const outboxPage = {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: 'https://localhost/outbox/test?page=true',
        type: 'OrderedCollectionPage',
        partOf: 'https://localhost/outbox/test',
        orderedItems: [3, 2, 1].map(i => ({
          type: 'Create',
          id: `${fakeId}${i}`,
          to: 'https://ignore.com/u/ignored',
          actor: 'https://localhost/u/test',
          object: {
            type: 'Note',
            id: `${fakeOId}${i}`,
            attributedTo: 'https://localhost/u/test',
            to: 'https://ignore.com/u/ignored',
            content: 'Say, did you finish reading that book I lent you?'
          }
        })),
        next: `https://localhost/outbox/test?page=${outbox[0]._id}`
      }
      request(app)
        .get('/outbox/test?page=true')
        .set('Accept', 'application/activity+json')
        .expect(200)
        .end((err, res) => {
          expect(res.body).toEqual(outboxPage)
          done(err)
        })
    })
    it('starts page after previous item', (done) => {
      const outboxPage = {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: `https://localhost/outbox/test?page=${outbox[1]._id}`,
        type: 'OrderedCollectionPage',
        partOf: 'https://localhost/outbox/test',
        orderedItems: [{
          type: 'Create',
          id: `${fakeId}${1}`,
          to: 'https://ignore.com/u/ignored',
          actor: 'https://localhost/u/test',
          object: {
            type: 'Note',
            id: `${fakeOId}${1}`,
            attributedTo: 'https://localhost/u/test',
            to: 'https://ignore.com/u/ignored',
            content: 'Say, did you finish reading that book I lent you?'
          }
        }],
        next: `https://localhost/outbox/test?page=${outbox[0]._id}`
      }
      request(app)
        .get(`/outbox/test?page=${outbox[1]._id}`)
        .set('Accept', 'application/activity+json')
        .expect(200)
        .end((err, res) => {
          expect(res.body).toEqual(outboxPage)
          done(err)
        })
    })
  })
})
