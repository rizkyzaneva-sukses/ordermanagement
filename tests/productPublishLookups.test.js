'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPEE_PARTNER_ID ||= '1';
process.env.SHOPEE_PARTNER_KEY ||= 'test';

const { normaliseChannels, normaliseAttributeTree } = require('../src/services/productPublish.js');

// Excerpt of get_channel_list as Zaneva Official Shop answered on 17 Sep 2026
const channelList = {
  logistics_channel_list: [
    { logistics_channel_id: 80021, logistics_channel_name: 'Indopaket (Ambil di Indomaret)', enabled: false, mask_channel_id: 0, weight_limit: { item_max_weight: 21 } },
    { logistics_channel_id: 8003, logistics_channel_name: 'Reguler (Cashless)', enabled: true, mask_channel_id: 0, weight_limit: { item_max_weight: 100 } },
    { logistics_channel_id: 8005, logistics_channel_name: 'Hemat Kargo', enabled: true, mask_channel_id: 0, weight_limit: { item_max_weight: 0 } },
    { logistics_channel_id: 80088, logistics_channel_name: 'SPX Standard', enabled: true, mask_channel_id: 8003, weight_limit: { item_max_weight: 50 } },
    { logistics_channel_id: 80005, logistics_channel_name: 'JNE Reguler', enabled: true, mask_channel_id: 8003, weight_limit: { item_max_weight: 50 } },
    { logistics_channel_id: 80031, logistics_channel_name: 'Sicepat Gokil', enabled: false, mask_channel_id: 8005, weight_limit: { item_max_weight: 50 } },
  ],
};

test('only top-level channels are choices; couriers are listed under their group', () => {
  const channels = normaliseChannels(channelList);
  assert.deepEqual(channels.map(c => c.channelId), [80021, 8003, 8005]);

  const reguler = channels.find(c => c.channelId === 8003);
  assert.deepEqual(reguler.couriers.map(k => k.name), ['SPX Standard', 'JNE Reguler']);
  assert.equal(reguler.enabled, true);

  // "maks 21.000g" on the Komplace form
  assert.equal(channels.find(c => c.channelId === 80021).maxWeightKg, 21);
  // Zero is "no limit given", not "nothing may be shipped"
  assert.equal(channels.find(c => c.channelId === 8005).maxWeightKg, 0);
});

test('attribute tree is read whichever naming the response uses', () => {
  const attrs = normaliseAttributeTree({
    list: [{
      category_id: 100637,
      attribute_tree: [
        {
          attribute_id: 100010, mandatory: true,
          multi_lang: [{ language: 'id', value: 'Jenis Kelamin' }],
          attribute_info: { input_type: 1, max_value_count: 1 },
          attribute_value_list: [{ value_id: 2, multi_lang: [{ language: 'id', value: 'Unisex' }] }],
        },
        {
          attribute_id: 100099, is_mandatory: false, display_attribute_name: 'Bahan',
          input_type: 'MULTIPLE_SELECT_COMBO_BOX',
          attribute_value_list: [{ value_id: 7, display_value_name: 'Katun' }],
        },
        { attribute_id: 0, name: 'broken' },
      ],
    }],
  }, 100637);

  assert.equal(attrs.length, 2);
  assert.deepEqual(attrs[0], {
    attributeId: 100010, name: 'Jenis Kelamin', mandatory: true, inputType: 'select',
    maxValues: 1, units: [], values: [{ valueId: 2, name: 'Unisex', unit: '' }],
  });
  assert.equal(attrs[1].inputType, 'multicombo');
  assert.equal(attrs[1].values[0].name, 'Katun');
});

test('an empty or unexpected attribute answer yields no attributes rather than an error', () => {
  assert.deepEqual(normaliseAttributeTree(undefined, 1), []);
  assert.deepEqual(normaliseAttributeTree({ list: [] }, 1), []);
});
