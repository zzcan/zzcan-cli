// core/stream.mjs — 流式槽：一轮回复对应一个 slot。
// begin/update/end 全部串在同一条 promise 链上，结构性保证 end（终稿）
// 排在任何 in-flight update 之后——不存在“迟到的中间态覆盖终稿”的竞态。
// 定时触发由调用方负责（daemon 的 setInterval 调 slot.tick）。
export function createStreamSlot(adapterStream, { log }) {
  const slot = {
    handle: null,
    updating: false,
    done: false,
    chain: Promise.resolve(),
  };

  slot.start = async (to) => {
    try {
      slot.handle = await adapterStream.begin(to);
    } catch (e) {
      log(`stream begin failed: ${e.message || e}`);
      slot.done = true;
    }
  };

  // getText 惰性求值：真要发了才读 transcript
  slot.tick = (getText) => {
    if (slot.done || slot.updating || !slot.handle) return;
    const text = getText();
    if (!text) return;
    slot.updating = true;
    slot.chain = slot.chain
      .then(() => adapterStream.update(slot.handle, text))
      .catch((e) => log(`stream update failed: ${e.message || e}`))
      .finally(() => { slot.updating = false; });
  };

  // 返回 true = 终稿已经由流式消息承载；false = 调用方需回退普通发送
  slot.finish = async (finalText) => {
    slot.done = true;
    if (!slot.handle) return false;
    await slot.chain.catch(() => {});
    try {
      await adapterStream.end(slot.handle, finalText);
      return true;
    } catch (e) {
      log(`stream end failed: ${e.message || e}`);
      return false;
    }
  };

  slot.cancel = () => { slot.done = true; };

  return slot;
}
