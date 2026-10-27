declare module 'https-tls' {
  import type { ConnectionOptions } from 'node:tls';

  type TLSOptions = Pick<
    ConnectionOptions,
    'ciphers' | 'ecdhCurve' | 'minVersion' | 'maxVersion'
  > & { signatureAlgorithms?: ConnectionOptions['sigalgs'] };

  function tls(userAgent: string): TLSOptions;

  export = tls;
}
