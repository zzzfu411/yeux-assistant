import { describe,it,expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { publicOrigin,checkOrigin,secureSession } from '../apps/api/src/http-policy.js';
const request=(origin:string,host='127.0.0.1:8765')=>({method:'POST',protocol:'http',headers:{host,origin,'x-forwarded-proto':'https','x-forwarded-host':'forged.invalid'}} as unknown as FastifyRequest);
describe('explicit server origin',()=>{
  it('accepts a root HTTPS origin or loopback HTTP and normalizes default ports',()=>{
    expect(publicOrigin(undefined)).toBeUndefined();
    expect(publicOrigin('https://YEUX.example:443/')).toBe('https://yeux.example');
    expect(publicOrigin('http://127.0.0.1:8765')).toBe('http://127.0.0.1:8765');
    expect(publicOrigin('http://[::1]:8765')).toBe('http://[::1]:8765');
  });
  it.each(['http://cloud.example','http://0.0.0.0:8765','https://user:password@example.com','https://example.com/path','https://example.com/?key=secret','https://example.com/#x','file:///tmp','not-an-origin'])('rejects invalid server origin %s',value=>expect(()=>publicOrigin(value)).toThrow());
  it('checks scheme, host and port for local clients, without trusting forwarded headers',()=>{
    expect(()=>checkOrigin(request('http://127.0.0.1:8765'))).not.toThrow();
    for(const origin of ['https://127.0.0.1:8765','http://127.0.0.1:8766','https://forged.invalid','null','http://127.0.0.1:8765/path'])expect(()=>checkOrigin(request(origin))).toThrow();
    expect(secureSession('http')).toBe(false);
  });
  it('accepts the configured HTTPS origin behind a proxy and requires Secure cookies',()=>{
    expect(()=>checkOrigin(request('https://study.example','api:8765'),'https://study.example')).not.toThrow();
    expect(()=>checkOrigin(request('http://study.example'),'https://study.example')).toThrow();
    expect(()=>checkOrigin(request('https://other.example'),'https://study.example')).toThrow();
    expect(secureSession('http','https://study.example')).toBe(true);
    expect(secureSession('http','http://127.0.0.1:8765')).toBe(false);
  });
});
