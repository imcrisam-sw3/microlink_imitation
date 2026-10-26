declare module 'https-tls' {
  import type { ConnectionOptions } from 'node:tls';

  type TLSOptions = Pick<
    ConnectionOptions,
    'ciphers' | 'sigalgs' | 'ecdhCurve' | 'minVersion' | 'maxVersion'
  >;

  function tls(userAgent: string): TLSOptions;

  export = tls;
}