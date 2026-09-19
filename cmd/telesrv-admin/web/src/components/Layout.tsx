import {
  AtSign,
  BadgeCheck,
  Bot,
  ChevronDown,
  Database,
  Film,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  Megaphone,
  Phone,
  BadgeDollarSign,
  Coins,
  ShieldAlert,
  ShieldCheck,
  Smile,
  Sticker,
  Trophy,
  Users,
  UserRound,
  Gift,
  KeyRound,
  ScrollText,
  Settings
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { LanguageSwitch, useI18n } from "../i18n";
import { permissionAuditRead, permissionAdminsManage, permissionBotVerificationReview, permissionMessagesRead, permissionPremiumManage, permissionServerManage, permissionStarsRead, permissionVerificationReview, useCan } from "../permissions";
import { type Navigate, type RouteState, routeSubtitle, routeTitle } from "../routing";
import { ThemeSwitch } from "../theme";
import { AppLink } from "./AppLink";
import { AppBackground } from "./AppBackground";

export function BootScreen() {
  const { t } = useI18n();
  return (
    <div className="boot-screen">
      <div className="brand compact brand-elevated">
        <span className="brand-mark"><img src="/logo.png" alt="" /></span>
        <span>
          <strong>telesrv</strong>
          <small>{t("app.adminConsole")}</small>
        </span>
      </div>
      <div className="loader-bar" />
    </div>
  );
}

export function Shell({
  actor,
  route,
  navigate,
  onLogout,
  children
}: {
  actor: string;
  route: RouteState;
  navigate: Navigate;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  // The verification queue is hidden for a session without verification.review:
  // the entry would only lead to a 403 (and the route itself is gated as well).
  const canReviewVerification = useCan(permissionVerificationReview);
  // Same reasoning for the third-party queue, which has its own right: the two
  // sections are granted independently, so one entry can be visible without the other.
  const canReviewBotVerification = useCan(permissionBotVerificationReview);
  const canManagePremium = useCan(permissionPremiumManage);
  // The console's own administration and its action trail are granted separately
  // from every working section: managing operators (admins.manage) or reading
  // what everyone has done (audit.read) deserves an explicit decision, so the
  // entries below are not even visible without the matching right.
  const canManageAdmins = useCan(permissionAdminsManage);
  const canReadAudit = useCan(permissionAuditRead);
  const canManageServer = useCan(permissionServerManage);
  const canReadStars = useCan(permissionStarsRead);
  const canReadMessages = useCan(permissionMessagesRead);

  // Server identity (name/icon) is admin-editable per Server Settings ->
  // Server identity, and takes over the sidebar branding when set -- the
  // operator's own server should look like their server, not like the
  // "telesrv" reference build, once they've bothered to configure it.
  // Only fetched for sessions that can even see Server Settings; a session
  // without that permission just gets the default branding.
  const [identity, setIdentity] = useState<{ name: string; iconExt?: string } | null>(null);
  useEffect(() => {
    if (!canManageServer) return;
    const load = () => {
      api.serverIdentity()
        .then((info) => setIdentity({ name: info.name, iconExt: info.icon_ext }))
        .catch(() => undefined);
    };
    load();
    // Server Settings fires this after saving a name/description/icon so the
    // sidebar and tab rebrand without a full page reload.
    window.addEventListener("telesrv:identity-changed", load);
    return () => window.removeEventListener("telesrv:identity-changed", load);
  }, [canManageServer]);
  const [brandIconFailed, setBrandIconFailed] = useState(false);
  const brandName = identity?.name?.trim() || "telesrv";
  const brandIconSrc = identity?.iconExt && !brandIconFailed ? api.serverIconURL() : "/logo.png";

  // The browser tab (title + favicon) follows the same custom-identity
  // override as the sidebar brand above, so a re-labeled server actually
  // looks like itself in the tab strip too, not just inside the app.
  useEffect(() => {
    document.title = `${brandName} admin`;
  }, [brandName]);
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    const linkEl = link;
    const src = identity?.iconExt && !brandIconFailed ? api.serverIconURL() : "/logo.png";
    // Browsers render the favicon file as-is -- they don't apply the
    // sidebar's CSS border-radius to it, so a square-cornered source image
    // shows up square in the tab strip. Bake the circular mask into the
    // actual pixels instead, the same way an app icon export would.
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        linkEl.href = src;
        return;
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, 0, 0, size, size);
      ctx.restore();
      linkEl.href = canvas.toDataURL("image/png");
    };
    img.onerror = () => {
      if (!cancelled) {
        linkEl.href = src;
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.iconExt, brandIconFailed]);

  const grantsActive = route.path.startsWith("/monetization") || route.path.startsWith("/premium") || route.path.startsWith("/give-gifts");
  const verificationActive = route.path.startsWith("/verification") || route.path.startsWith("/bot-verification");
  const starGiftsActive = route.path.startsWith("/gifts") || route.path.startsWith("/auctions");

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <AppLink className="brand" href="/" navigate={navigate}>
          <span className="brand-mark"><img src={brandIconSrc} alt={brandName} onError={() => setBrandIconFailed(true)} /></span>
          <span>
            <strong>{brandName}</strong>
            <small>{t("app.adminConsole")}</small>
          </span>
        </AppLink>
        <div className="sidebar-label">{t("layout.navigation")}</div>
        <nav className="nav-list" aria-label={t("layout.primaryNav")}>
          <NavLink icon={<LayoutDashboard size={16} />} href="/" route={route} navigate={navigate}>{t("layout.dashboard")}</NavLink>
          <NavLink icon={<Users size={16} />} href="/accounts" route={route} navigate={navigate}>{t("layout.accounts")}</NavLink>
          <NavLink icon={<ShieldCheck size={16} />} href="/channels" route={route} navigate={navigate}>{t("layout.channels")}</NavLink>
          <NavLink icon={<Bot size={16} />} href="/bots" route={route} navigate={navigate}>{t("layout.bots")}</NavLink>
          <NavLink icon={<Megaphone size={16} />} href="/broadcasts" route={route} navigate={navigate}>{t("layout.broadcasts")}</NavLink>
          <NavSection icon={<BadgeDollarSign size={16} />} label={t("layout.grants")} active={grantsActive}>
            {canManagePremium && (
              <NavLink href="/monetization" route={route} navigate={navigate}
                activeWhen={(path) => path.startsWith("/monetization") || path.startsWith("/premium")}>
                {t("layout.premium")}
              </NavLink>
            )}
            <NavLink href="/give-gifts" route={route} navigate={navigate}>{t("layout.giveGifts")}</NavLink>
          </NavSection>
          <NavLink icon={<ShieldAlert size={16} />} href="/moderation" route={route} navigate={navigate}>{t("layout.moderation")}</NavLink>
          {(canReviewVerification || canReviewBotVerification) && (
            <NavSection icon={<BadgeCheck size={16} />} label={t("layout.verification")} active={verificationActive}>
              {canReviewVerification && (
                <NavLink href="/verification" route={route} navigate={navigate}>{t("route.verification")}</NavLink>
              )}
              {canReviewBotVerification && (
                <NavLink href="/bot-verification" route={route} navigate={navigate}>{t("layout.botVerification")}</NavLink>
              )}
            </NavSection>
          )}
          <NavLink icon={<AtSign size={16} />} href="/collectible-usernames" route={route} navigate={navigate}>{t("layout.collectibleUsernames")}</NavLink>
          <NavLink icon={<Phone size={16} />} href="/collectible-phones" route={route} navigate={navigate}>{t("layout.collectiblePhones")}</NavLink>
          <NavLink icon={<Trophy size={16} />} href="/account-ratings" route={route} navigate={navigate}>{t("layout.accountRatings")}</NavLink>
          {canReadStars && (
            <NavLink icon={<Coins size={16} />} href="/stars" route={route} navigate={navigate}>{t("layout.stars")}</NavLink>
          )}
          <NavLink icon={<Database size={16} />} href="/storage" route={route} navigate={navigate}>{t("layout.storage")}</NavLink>
          <NavSection icon={<Gift size={16} />} label={t("layout.gifts")} active={starGiftsActive}>
            <NavLink href="/gifts" route={route} navigate={navigate}>{t("gifts.pageTitle")}</NavLink>
            <NavLink href="/auctions" route={route} navigate={navigate}>{t("layout.auctions")}</NavLink>
          </NavSection>
          <NavLink icon={<Sticker size={16} />} href="/stickers" route={route} navigate={navigate}>{t("layout.stickers")}</NavLink>
          <NavLink icon={<Smile size={16} />} href="/emoji" route={route} navigate={navigate}>{t("layout.emoji")}</NavLink>
          <NavLink icon={<Film size={16} />} href="/gif-catalog" route={route} navigate={navigate}>{t("layout.gifCatalog")}</NavLink>
          {canReadMessages && (
            <NavLink
              icon={<MessageSquareText size={16} />}
              href="/messages/private"
              route={route}
              navigate={navigate}
              activeWhen={(path) => path.startsWith("/messages")}
            >
              {t("layout.messages")}
            </NavLink>
          )}
          {canManageAdmins && (
            <NavLink icon={<KeyRound size={16} />} href="/admin-users" route={route} navigate={navigate}>{t("layout.adminUsers")}</NavLink>
          )}
          {canReadAudit && (
            <NavLink icon={<ScrollText size={16} />} href="/audit-log" route={route} navigate={navigate}>{t("layout.auditLog")}</NavLink>
          )}
          {canManageServer && (
            <NavLink icon={<Settings size={16} />} href="/server-settings" route={route} navigate={navigate}>{t("layout.serverSettings")}</NavLink>
          )}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">{routeSubtitle(route.path, t)}</div>
            <h1>{routeTitle(route.path, t)}</h1>
          </div>
          <div className="topbar-actions">
            <ThemeSwitch />
            <LanguageSwitch />
            <span className="actor-pill"><UserRound size={14} /> {actor}</span>
            <button className="btn ghost icon-text" type="button" onClick={logout} title={t("layout.logout")}>
              <LogOut size={16} /> {t("layout.logout")}
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      <AppBackground className="app-background--workspace" />
    </div>
  );
}

function NavLink({
  href,
  route,
  navigate,
  icon,
  children,
  activeWhen
}: {
  href: string;
  route: RouteState;
  navigate: Navigate;
  icon?: ReactNode;
  children: ReactNode;
  activeWhen?: (path: string) => boolean;
}) {
  const active = activeWhen ? activeWhen(route.path) : href === "/" ? route.path === "/" : route.path.startsWith(href);
  return (
    <AppLink className={`nav-item ${active ? "active" : ""}`} href={href} navigate={navigate}>
      {icon ?? <span aria-hidden="true" className="nav-dot" />}
      <span>{children}</span>
    </AppLink>
  );
}

// Collapsible group in the sidebar, mirroring the "settings / services"
// sub-menu pattern: the header toggles the group, and the group auto-opens
// whenever the current route lives inside it so a deep link never lands on a
// closed folder.
function NavSection({
  icon,
  label,
  active,
  children
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(active);

  useEffect(() => {
    if (active) {
      setOpen(true);
    }
  }, [active]);

  return (
    <div className={`nav-section ${active ? "active" : ""} ${open ? "open" : ""}`}>
      <button
        className="nav-section-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown className="nav-section-chevron" size={15} />
      </button>
      {open && <div className="nav-children">{children}</div>}
    </div>
  );
}
