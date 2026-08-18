function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = toBytes(left);
  const rightBytes = toBytes(right);
  const size = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < size; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? request.headers.get("x-remote-control-token");
  if (!value) return null;
  return value.startsWith("Bearer ") ? value.slice(7).trim() : value.trim();
}

export function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const received = bearerToken(request);
  return received !== null && timingSafeEqual(received, expected);
}

export function base64Url(value: string): string {
  const bytes = toBytes(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function websocketToken(request: Request): string | null {
  const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((part) => part.trim()) ?? [];
  const tokenProtocol = protocols.find((protocol) => protocol.startsWith("token."));
  return tokenProtocol?.slice("token.".length) ?? null;
}
