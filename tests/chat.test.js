'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { jsonWithInt64 } = require('../src/services/shopee.js');
const chat = require('../src/services/chat.js');

const store = { id: 'st1', name: 'Zaneva Official Shop', shopId: '123456' };

test('an int64 conversation id reaches Shopee digit for digit', () => {
  // 38732689394223980 is past 2^53: through Number() it would silently become
  // a neighbouring id and mark or message the wrong conversation.
  const body = jsonWithInt64(
    { conversation_id: '38732689394223981', last_read_message_id: '2064780411604648076' },
    ['conversation_id'],
  );
  assert.equal(body, '{"conversation_id":38732689394223981,"last_read_message_id":"2064780411604648076"}');
  assert.notEqual(String(Number('38732689394223981')), '38732689394223981');
});

test('a non-numeric id is refused rather than sent', () => {
  assert.throws(() => jsonWithInt64({ to_id: '12; drop' }, ['to_id']), /numeric id/);
});

test('conversation: last word from the buyer means a reply is owed', () => {
  const c = chat.mapConversation({
    conversation_id: '38732689394223977',
    to_id: 9030505,
    to_name: 'tsx_buyer1000',
    unread_count: 8,
    latest_message_type: 'text',
    latest_message_content: { text: '11' },
    latest_message_from_id: 9030505,
    last_message_timestamp: 1612792485343461649,
  }, store);

  assert.equal(c.id, '38732689394223977');
  assert.equal(c.buyerId, '9030505');
  assert.equal(c.unread, 8);
  assert.equal(c.awaitingReply, true);
  assert.equal(c.lastMessage, '11');
  assert.equal(c.lastAt, 1612792485343);
});

test('conversation: a non-text last message still gets a preview', () => {
  const c = chat.mapConversation({
    conversation_id: '1', to_id: 5, latest_message_type: 'product', latest_message_content: null,
    latest_message_from_id: 9, last_message_timestamp: 0,
  }, store);
  assert.equal(c.lastMessage, '[Produk]');
  assert.equal(c.awaitingReply, false);
  assert.equal(c.lastAt, null);
});

test('message: the shop side is told apart by from_shop_id', () => {
  const mine = chat.mapMessage({ message_id: '1', message_type: 'text', from_shop_id: 123456, content: { text: 'Halo kak' }, created_timestamp: 1615260187 }, store, 'Admin');
  const theirs = chat.mapMessage({ message_id: '2', message_type: 'image', from_shop_id: 0, content: { url: 'https://cf/x' } }, store);

  assert.equal(mine.fromShop, true);
  assert.equal(mine.sentBy, 'Admin');
  assert.equal(mine.createdAt, 1615260187000);
  assert.equal(theirs.fromShop, false);
  assert.equal(theirs.imageUrl, 'https://cf/x');
  assert.equal(theirs.preview, '[Gambar]');
});

test('message: an order card carries its order number for the side panel', () => {
  const m = chat.mapMessage({ message_id: '3', message_type: 'order', from_shop_id: 0, content: { order_sn: '260922NMVFM7S2' } }, store);
  assert.equal(m.orderSn, '260922NMVFM7S2');
  assert.equal(m.preview, '[Pesanan 260922NMVFM7S2]');
});

test('cursor survives the round trip and ends when no store has more', () => {
  const cursor = chat.encodeCursor({ a: '1612792485343461649', b: null });
  assert.deepEqual(chat.decodeCursor(cursor), { a: '1612792485343461649', b: null });
  assert.equal(chat.encodeCursor({ a: null, b: null }), null);
  assert.throws(() => chat.decodeCursor('!!!'), /cursor tidak valid/);
});

test('a permission refusal is recognised, an ordinary error is not', () => {
  assert.equal(chat.isPermissionError({ shopeeError: 'error_permission', shopeeMessage: 'no permission' }), true);
  assert.equal(chat.isPermissionError({ shopeeError: 'user_is_unauthorized' }), true);
  assert.equal(chat.isPermissionError({ shopeeError: 'system_busy', shopeeMessage: 'decrease qps' }), false);
});
