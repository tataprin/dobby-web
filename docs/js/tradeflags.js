// Which MT5 trade permission is off (same order and words as the Dobby App's trade_block).
// EA v3.06 sends account.trade_flags { ea, terminal, account, expert } next to the combined trade_permitted:
//   ea = the EA's own Allow Algo Trading tick (F7 > Common), terminal = the toolbar Algo Trading button,
//   account = the account may trade (false: investor password, no connection, disabled), expert = the broker allows EAs.
// Login / broker problems first: no button helps until they are fixed. An older EA sends only trade_permitted:
// then the old message (toolbar button).
export function tradeBlock(a) {
  a = a || {};
  if (a.trade_permitted !== false) return null;
  const f = a.trade_flags && typeof a.trade_flags === 'object' && !Array.isArray(a.trade_flags) ? a.trade_flags : {};
  const off = (k) => f[k] === false;
  if (off('account')) {
    if (a.connected === false) return { key: 'connection', tone: 'critical', label: 'MT5 ไม่ได้เชื่อมต่อโบรกเกอร์', text: 'ตรวจอินเทอร์เน็ตหรือการล็อกอินบัญชีใน MT5 ที่เครื่อง' };
    return { key: 'account', tone: 'critical', label: 'MT5 ล็อกอินแบบดูได้อย่างเดียว', text: 'บัญชีนี้ส่งคำสั่งไม่ได้ มักเพราะล็อกอินด้วยรหัสผ่านนักลงทุน (investor): ที่เครื่อง ใน MT5 กด File > Login to Trade Account แล้วใส่รหัสผ่านหลัก (ถ้าใช้รหัสหลักอยู่แล้ว ให้ถามโบรกว่าบัญชีถูกปิดการเทรดไหม)' };
  }
  if (off('expert')) return { key: 'expert', tone: 'critical', label: 'โบรกไม่อนุญาตให้ใช้บอทกับบัญชีนี้', text: 'โบรกปิดการเทรดด้วย EA ของบัญชีนี้ไว้ กดปุ่มใน MT5 ก็แก้ไม่ได้: ติดต่อโบรกให้เปิด หรือใช้บัญชีอื่น' };
  if (off('terminal') && off('ea')) return { key: 'terminal_ea', tone: 'warn', label: 'ปุ่ม Algo Trading ปิดอยู่', text: 'ที่เครื่อง: กดปุ่ม Algo Trading บนแถบเครื่องมือของ MT5 ให้เป็นสีเขียว และติ๊ก Allow Algo Trading ของ Dobby (คลิกกราฟของ Dobby กด F7 > แท็บ Common)' };
  if (off('terminal')) return { key: 'terminal', tone: 'warn', label: 'ปุ่ม Algo Trading ปิดอยู่', text: 'กดปุ่ม Algo Trading บนแถบเครื่องมือของ MT5 ที่เครื่อง ให้เป็นสีเขียว' };
  if (off('ea')) return { key: 'ea', tone: 'warn', label: 'ยังไม่ได้ติ๊ก Allow Algo Trading ของ Dobby', text: 'ปุ่มบนแถบเครื่องมือเปิดแล้ว เหลือติ๊กของ Dobby ที่เครื่อง: คลิกกราฟที่มี Dobby กด F7 > แท็บ Common > ติ๊ก Allow Algo Trading > OK' };
  return { key: 'unknown', tone: 'warn', label: 'ปุ่ม Algo Trading ปิดอยู่', text: 'กดปุ่ม Algo Trading บนแถบเครื่องมือของ MT5 ที่เครื่อง ให้เป็นสีเขียว' };
}
