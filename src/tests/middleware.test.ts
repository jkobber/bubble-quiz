import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock next-intl and auth using hoisted variables
const { intlMiddlewareMock, authMock } = vi.hoisted(() => {
  return {
    intlMiddlewareMock: vi.fn((req) => NextResponse.next()),
    authMock: vi.fn(),
  };
});

vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => intlMiddlewareMock),
}));

vi.mock("next-intl/navigation", () => ({
  createNavigation: vi.fn(() => ({
    Link: vi.fn(),
    redirect: vi.fn(),
    usePathname: vi.fn(),
    useRouter: vi.fn(),
    getPathname: vi.fn(),
  })),
}));

vi.mock("next-intl/routing", () => ({
  defineRouting: vi.fn((c) => c),
}));

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

// Mock i18n routing
vi.mock("./i18n/routing", () => ({
  routing: {},
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
}));

// The middleware itself
import middleware from "@/proxy";

function createMockRequest(path: string, authData: any = null, headers: Record<string, string> = {}) {
  const url = `http://localhost${path}`;
  const req = new NextRequest(url, { headers });
  authMock.mockResolvedValue(authData);
  return req;
}

describe("Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow public access to lobby (via intl)", async () => {
    const req = createMockRequest("/lobby");
    const res = await middleware(req, {} as any);
    expect(intlMiddlewareMock).toHaveBeenCalled();
  });

  it("should return 404 rewrite for unauthorized users from /admin", async () => {
    const req = createMockRequest("/admin");
    const res = (await middleware(req, {} as any)) as NextResponse;
    expect(res.headers.get("x-middleware-rewrite")).toContain("/404");
  });

  it("should return 404 rewrite for non-admin users from /admin", async () => {
    const req = createMockRequest("/admin", { user: { role: "USER", username: "alice" } });
    const res = (await middleware(req, {} as any)) as NextResponse;
    expect(res.headers.get("x-middleware-rewrite")).toContain("/404");
  });

  it("should redirect users with no username to /onboarding", async () => {
    const req = createMockRequest("/lobby", { user: { role: "USER" } });
    const res = (await middleware(req, {} as any)) as NextResponse;
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/onboarding");
  });

  it("should redirect logged-in users away from /register", async () => {
    const req = createMockRequest("/register", { user: { role: "USER", username: "alice" } });
    const res = (await middleware(req, {} as any)) as NextResponse;
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/lobby");
  });

  it("should handle X-Forwarded-Host", async () => {
    const req = createMockRequest("/pregame", null, { "x-forwarded-host": "tunnel.com", "x-forwarded-proto": "https" });
    const res = (await middleware(req, {} as any)) as NextResponse;
    expect(res.headers.get("location")).toContain("https://tunnel.com/api/auth/signin");
  });

  it("should handle already onboarded users on /onboarding", async () => {
    const req = createMockRequest("/onboarding", { user: { role: "USER", username: "alice" } });
    const res = (await middleware(req, {} as any)) as NextResponse;
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/lobby");
  });

  it("should redirect unauth users from /pregame", async () => {
    authMock.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/pregame/123");
    
    // @ts-ignore
    const res = await middleware(req);
    // @ts-ignore
    const location = res.headers.get("location");
    expect(location).toContain("/api/auth/signin");
    expect(location).toContain("callbackUrl=%2Fpregame%2F123");
  });

  it("should allow Admin through to admin routes", async () => {
    const req = createMockRequest("/admin", { user: { role: "ADMIN", username: "admin" } });
    const res = await middleware(req, {} as any);
    expect(intlMiddlewareMock).toHaveBeenCalled();
  });

  it("should allow users with username through", async () => {
    const req = createMockRequest("/lobby", { user: { role: "USER", username: "alice" } });
    const res = await middleware(req, {} as any);
    expect(intlMiddlewareMock).toHaveBeenCalled();
  });
});
