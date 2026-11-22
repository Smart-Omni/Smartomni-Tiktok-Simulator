import { expect, test } from '@playwright/test';
import { BUYER_A, demoSession, resetAll, SELLER_A, shot, signInAs } from './helpers';

/** Phase 08 UI: buyer writes -> seller sees and replies -> buyer sees the reply; unsupported message types are stated explicitly. */
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const buyerText = `Shop oi, don cua minh khi nao giao? [${stamp}]`;
const sellerText = `Da nhan yeu cau, shop se gui hang som [${stamp}]`;

test.beforeAll(async ({ baseURL }) => {
  await resetAll(baseURL);
});

// The redesigned chat UI no longer prints a "Supported message types" note (removed on purpose in 2d657fe / 4b921cb);
// the rule is still served by the chat API and the composer stays text-only, so that is what is checked here.
test('chat is text only: the API states supported and not simulated types and the composer has no attachments', async ({ page, request }) => {
  const buyer = await demoSession(request, 'BUYER', BUYER_A);
  const list = await (await request.get(`/demo/shops/${buyer.shopId}/chat/conversations`, { headers: { 'x-demo-session': buyer.token } })).json();
  expect(list.supportedTypes).toEqual(['TEXT']);
  expect(list.unsupported).toContain('IMAGE');

  await signInAs(page, 'BUYER', BUYER_A, '/account/messages');
  const thread = page.getByRole('region', { name: 'Chat thread' });
  await expect(thread.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(thread.locator('input[type="file"]')).toHaveCount(0);
  await shot(page, 'phase08-supported-types');
});

test('buyer sends a message, seller sees it and replies, buyer sees the reply', async ({ browser }) => {
  const buyerCtx = await browser.newContext();
  const sellerCtx = await browser.newContext();
  const buyer = await buyerCtx.newPage();
  const seller = await sellerCtx.newPage();
  try {
    await signInAs(buyer, 'BUYER', BUYER_A, '/account/messages');
    const thread = buyer.getByRole('region', { name: 'Chat thread' });
    await thread.getByRole('textbox', { name: 'Message' }).fill(buyerText);
    await thread.getByRole('button', { name: 'Send' }).click();
    await expect(thread.getByRole('list', { name: 'Messages' }).getByText(buyerText)).toBeVisible();

    await signInAs(seller, 'SELLER', SELLER_A, '/seller-center/messages');
    await seller.getByRole('list', { name: 'Conversations' }).getByRole('button', { name: new RegExp(BUYER_A) }).click();
    const sthread = seller.getByRole('region', { name: 'Chat thread' });
    await expect(sthread.getByText(buyerText)).toBeVisible();
    await sthread.getByRole('textbox', { name: 'Message' }).fill(sellerText);
    await sthread.getByRole('button', { name: 'Send' }).click();
    await expect(sthread.getByText(sellerText)).toBeVisible();
    await shot(seller, 'phase08-seller-thread');

    // the buyer view polls every 3 s
    await expect(thread.getByText(sellerText)).toBeVisible({ timeout: 15_000 });
    const items = await thread.getByRole('list', { name: 'Messages' }).getByRole('listitem').allInnerTexts();
    const iBuyer = items.findIndex((t) => t.includes(buyerText));
    const iSeller = items.findIndex((t) => t.includes(sellerText));
    expect(iBuyer).toBeGreaterThanOrEqual(0);
    expect(iSeller).toBeGreaterThan(iBuyer); // order preserved
    await shot(buyer, 'phase08-buyer-thread');
  } finally {
    await buyerCtx.close();
    await sellerCtx.close();
  }
});

test('an empty message cannot be sent and the seller sees only its own shop conversations', async ({ page }) => {
  await signInAs(page, 'SELLER', SELLER_A, '/seller-center/messages');
  const list = page.getByRole('list', { name: 'Conversations' });
  await expect(list.getByRole('button', { name: new RegExp(BUYER_A) })).toBeVisible();
  await expect(list.getByText('Hoàng Đức Long')).toHaveCount(0); // a buyer of the other shop
  await list.getByRole('button', { name: new RegExp(BUYER_A) }).click();
  const thread = page.getByRole('region', { name: 'Chat thread' });
  await thread.getByRole('textbox', { name: 'Message' }).fill('   ');
  await expect(thread.getByRole('button', { name: 'Send' })).toBeDisabled();
});
