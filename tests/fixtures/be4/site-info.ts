/** Synthetic core_webservice_get_site_info response. */

export function siteInfo(overrides: Record<string, unknown> = {}) {
  return {
    sitename: 'Waseda Moodle',
    username: 'taro.yamada',
    fullname: 'Taro Yamada',
    lang: 'ja',
    userid: 1001,
    siteurl: 'https://wsdmoodle.waseda.jp',
    functions: [{ name: 'core_webservice_get_site_info', version: '2025100604' }],
    downloadfiles: 1,
    uploadfiles: 1,
    release: '5.1.4 (Build: 20260420)',
    ...overrides,
  };
}

export const TOKEN_A = 'abcdef0123456789abcdef0123456789';
export const TOKEN_B = '0123456789abcdef0123456789abcdef';
