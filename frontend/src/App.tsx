import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  BarChart3,
  Briefcase,
  CalendarRange,
  ChevronDown,
  CircleAlert,
  Download,
  Filter,
  LayoutDashboard,
  Package,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  Siren,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Upload,
  UserRoundSearch,
  Users,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./App.css";
import SalesAiInsightsPanel from "./components/SalesAiInsightsPanel";
const VisitForm = lazy(() => import("./components/VisitForm"));
const DataEntry = lazy(() => import("./DataEntry"));
const AdminPanel = lazy(() => import("./components/AdminPanel"));
import "./sales_ai_insights.css";
const ForecastTab = lazy(() => import("./components/ForecastTab"));
const RessiBot = lazy(() => import("./components/RessiBot"));
const ProductContributionTab = lazy(() => import("./components/ProductContributionTab"));
const OrgAdmin = lazy(() => import("./v2/OrgAdmin"));
const MultiYear = lazy(() => import("./v2/MultiYear"));
const VisitPlanner = lazy(() => import("./v2/VisitPlanner"));
const Customer360 = lazy(() => import("./v2/Customer360"));
const ImportDialog = lazy(() => import("./v2/ImportDialog"));
const DangerZone = lazy(() => import("./v2/DangerZone"));
const HomePage = lazy(() => import("./v2/HomePage"));

// Tabs that use the Global Filters (team / city / branch / salesperson / month / products)
const FILTER_TABS = ["overview", "multiYear", "clients", "products", "team", "recovery", "executive"];
import { useTheme } from "./v2/theme";
import Sidebar, { APP_VERSION } from "./v2/Sidebar";
import LoginPage from "./v2/LoginPage";
import { chartColors } from "./v2/accent";
import { apiJson } from "./v2/authFetch";
import { ArrowUpRight, Building2, CalendarClock, ClipboardList, Contact, House, Layers, MapPin, SlidersHorizontal } from "lucide-react";
import ActionMenu from "./v2/ActionMenu";

type ClientStatus = "new" | "lost" | "retained";
type Severity = "high" | "medium" | "low";
type RecoveryPriority = "high" | "medium" | "low";
type InsightTone = "positive" | "warning" | "negative" | "neutral";
// PDF libraries are only downloaded when someone exports a PDF
const loadPdf = async () => {
  const mod = await import("jspdf");
  await import("jspdf-autotable");
  return { jsPDF: mod.default };
};

const TabFallback = () => (
  <div className="card v2-skeleton" aria-busy="true">
    <div /> <div /> <div />
  </div>
);

type TabKey = "overview" | "clients" | "products" | "team" | "recovery" | "executive" | "visit" | "dataEntry" | "admin" | "forecast" | "productContribution" | "organization" | "multiYear" | "planner" | "customers" | "home";

type OrgTreeTeam = { id: number; name: string; branch_id: number | null };
type OrgTreeBranch = { id: number; city_id: number; name: string; code: string; teams: OrgTreeTeam[] };
type OrgTreeCity = { id: number; name: string; code: string; branches: OrgTreeBranch[] };

const ROLE_LABELS: Record<string, string> = {
  admin: "Super Admin",
  super_user: "Boss / Executive",
  city_coordinator: "City Coordinator",
  dashboard_admin: "Dashboard Admin",
  team_leader: "Team Leader",
  user: "Team Member",
};

const NAV_GROUPS: { key: string; label: string; tabs: TabKey[] }[] = [
  { key: "start", label: "Start", tabs: ["home"] },
  {
    key: "intel",
    label: "Sales Intelligence",
    tabs: ["overview", "multiYear", "clients", "products", "team", "recovery", "executive", "forecast", "productContribution"],
  },
  { key: "field", label: "Field Operations", tabs: ["planner", "visit", "dataEntry"] },
  { key: "crm", label: "Customers", tabs: ["customers"] },
  { key: "admin", label: "Administration", tabs: ["admin", "organization"] },
];

type Summary = {
  current_year?: number;
  previous_year?: number;
  this_year_sales: number;
  last_year_sales: number;
  growth: number;
  lost_clients: number;
  new_clients: number;
  retained_clients: number;
  top_product: string;
  weakest_sales_person: string;
  top_sales_person: string;
  available_months_count: number;
  fastest_growing_product?: string;
  declining_product?: string;
  product_concentration_risk?: number;
  retained_client_rate?: number;
  lost_vs_new_gap?: number;
};

type TeamMember = {
  name: string;
  last_year: number;
  this_year: number;
  change_percent: number;
};

type ClientItem = {
  name: string;
  status: ClientStatus;
  quantity: number;
};

type ProductItem = {
  name: string;
  sales: number;
  share: number;
};

type ChartItem = {
  month: string;
  previous?: number;
  current?: number;
  [key: string]: string | number | undefined;
};

type MonthComparisonItem = {
  month: string;
  previous: number;
  current: number;
  growth_percent: number;
  delta: number;
};

type AlertItem = {
  severity: Severity;
  title: string;
  message: string;
};

type LostClientRecoveryItem = {
  client_name: string;
  last_year_quantity: number;
  assigned_sales_person: string;
  dominant_product: string;
  priority_score: number;
  recovery_priority: RecoveryPriority;
};

type SalesScorecardItem = {
  name: string;
  last_year: number;
  this_year: number;
  change_percent: number;
  active_clients: number;
  new_clients: number;
  lost_clients: number;
  retained_clients: number;
  top_product: string;
  recovery_opportunity: number;
};

type ProductTrendPoint = {
  month: string;
  previous: number;
  current: number;
};

type ProductDrilldownItem = {
  name: string;
  last_year_sales: number;
  this_year_sales: number;
  growth_percent: number;
  client_count: number;
  top_sales_person: string;
  monthly_trend: ProductTrendPoint[];
};

type ClientDrilldownItem = {
  name: string;
  status: ClientStatus;
  current_year_quantity: number;
  previous_year_quantity: number;
  delta: number;
  dominant_product: string;
  assigned_sales_person: string;
  monthly_trend: ProductTrendPoint[];
};

type NewClientQualityItem = {
  client_name: string;
  first_active_month: string;
  sales_person: string;
  quantity: number;
  product_mix: { product: string; quantity: number }[];
  is_meaningful: boolean;
  quality_label: "strong" | "trial" | "developing";
};

type ExecutiveSummary = {
  headline: string;
  highlights: string[];
  risks: string[];
  opportunities: string[];
};

type TargetSummary = {
  target_bags: number;
  actual_bags: number;
  achievement_percent: number;
  gap: number;
  required_run_rate: number;
  enabled: boolean;
};

type DashboardMeta = {
  source_file?: string;
  last_processed_at?: string;
  cache_used?: boolean;
  ai_enabled?: boolean;
  ai_provider?: string;
};

type DashboardResponse = {
  summary: Summary;
  team: TeamMember[];
  clients: ClientItem[];
  products: ProductItem[];
  chart: ChartItem[];
  available_months: string[];
  month_comparison: MonthComparisonItem[];
  alerts: AlertItem[];
  lost_client_recovery: LostClientRecoveryItem[];
  sales_scorecards: SalesScorecardItem[];
  salesperson_monthly_trend: {
    name: string;
    monthly_trend: ProductTrendPoint[];
  }[];
  product_drilldown: ProductDrilldownItem[];
  client_drilldown: ClientDrilldownItem[];
  new_client_quality: NewClientQualityItem[];
  executive_summary: ExecutiveSummary;
  target_summary: TargetSummary;
  metadata?: DashboardMeta;
};

type InsightItem = {
  title: string;
  description: string;
  tone: InsightTone;
};

type PaginationState = {
  clientPage: number;
  productPage: number;
  recoveryPage: number;
};

const STORAGE_KEY = "sales-dashboard-ui-state-final";
const PAGE_SIZE = 12;
const API_BASE_URL =
  ((import.meta as any)?.env?.VITE_API_BASE_URL as string) ||
  (window.location.port === "5173" ? "http://127.0.0.1:8000" : "");

function clampPage(page: number, pageCount: number) {
  if (pageCount <= 0) return 1;
  return Math.max(1, Math.min(page, pageCount));
}

function slicePage<T>(items: T[], page: number, pageSize = PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = clampPage(page, pageCount);
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    pageCount,
    page: safePage,
  };
}

function getGrowthPercent(previous: number, current: number) {
  if (!previous && !current) return 0;
  if (!previous) return 100;
  return ((current - previous) / previous) * 100;
}

function getStoredState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const fallbackData: DashboardResponse = {
  summary: {
    current_year: undefined,
    previous_year: undefined,
    this_year_sales: 0,
    last_year_sales: 0,
    growth: 0,
    lost_clients: 0,
    new_clients: 0,
    retained_clients: 0,
    top_product: "N/A",
    weakest_sales_person: "N/A",
    top_sales_person: "N/A",
    available_months_count: 0,
    fastest_growing_product: "N/A",
    declining_product: "N/A",
    product_concentration_risk: 0,
    retained_client_rate: 0,
    lost_vs_new_gap: 0,
  },
  team: [],
  clients: [],
  products: [],
  chart: [],
  available_months: [],
  month_comparison: [],
  alerts: [],
  lost_client_recovery: [],
  sales_scorecards: [],
  salesperson_monthly_trend: [],
  product_drilldown: [],
  client_drilldown: [],
  new_client_quality: [],
  executive_summary: {
    headline: "No data loaded",
    highlights: [],
    risks: [],
    opportunities: [],
  },
  target_summary: {
    target_bags: 0,
    actual_bags: 0,
    achievement_percent: 0,
    gap: 0,
    required_run_rate: 0,
    enabled: false,
  },
  metadata: {},
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(Math.round(value || 0));
}

function formatWithUnit(value: number, unit: "bag" | "kg") {
  return `${formatNumber(value)} ${unit}`;
}

function formatPercent(value: number) {
  const safeValue = Number(value || 0);
  return `${safeValue > 0 ? "+" : ""}${safeValue.toFixed(2)}%`;
}

function formatMeaningfulGrowth(previous: number, current: number, growth?: number) {
  if (previous === 0 && current > 0) {
    return "NEW";
  }

  if (previous === 0 && current === 0) {
    return "No Activity";
  }

  return formatPercent(growth ?? getGrowthPercent(previous, current));
}

function getBadgeClass(
  value: ClientStatus | RecoveryPriority | NewClientQualityItem["quality_label"]
) {
  if (value === "lost" || value === "high" || value === "trial") return "badge danger";
  if (value === "new" || value === "strong") return "badge success";
  if (value === "medium" || value === "developing") return "badge warning";
  return "badge neutral";
}

function getAlertClass(severity: Severity) {
  if (severity === "high") return "alert-card high";
  if (severity === "medium") return "alert-card medium";
  return "alert-card low";
}

/*
function sumProductTrendByMonths(
  products: ProductDrilldownItem[],
  months: string[]
) {
  return months.map((month) => {
    let previous = 0;
    let current = 0;

    for (const product of products) {
      const row = product.monthly_trend.find((m) => m.month === month);
      previous += Number(row?.previous || 0);
      current += Number(row?.current || 0);
    }

    return {
      month,
      previous,
      current,
    };
  });
}
*/

function getTopProductFromProducts(products: ProductDrilldownItem[]) {
  if (!products.length) return "N/A";
  return [...products].sort((a, b) => b.this_year_sales - a.this_year_sales)[0]?.name || "N/A";
}

function App() {
  const stored = typeof window !== "undefined" ? getStoredState() : null;
  const [authUser] = useState<any>(() => {
    const raw = localStorage.getItem("auth_user");
    return raw ? JSON.parse(raw) : null;
  });
  const userRole: string = authUser?.role || "";
  const isAdmin = userRole === "admin";
  const isSuperUser = userRole === "super_user";
  // V2 scoped roles see dashboards, but only for teams inside their city/branch/team scope
  const isScopedManager = userRole === "city_coordinator" || userRole === "dashboard_admin";
  const canViewAllTeams = isAdmin || isSuperUser;
  const canViewDashboards = canViewAllTeams || isScopedManager;
  const { theme, toggle: toggleTheme, accent, setAccent } = useTheme();
  const chart = chartColors(accent, theme);
  const axisProps = { tick: { fill: chart.tick, fontSize: 12 }, axisLine: false, tickLine: false } as const;
  const tooltipProps = {
    contentStyle: {
      background: chart.tooltipBg,
      border: `1px solid ${chart.tooltipBorder}`,
      borderRadius: 14,
      boxShadow: "0 18px 40px rgba(0,0,0,0.25)",
      backdropFilter: "blur(10px)",
      color: chart.tooltipText,
      padding: "10px 14px",
    },
    labelStyle: { color: chart.tooltipText, fontWeight: 700, marginBottom: 4 },
    itemStyle: { color: chart.tooltipText },
    cursor: { fill: chart.cursor, stroke: chart.accent, strokeOpacity: 0.25 },
  } as const;

  
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");

  const handleLogin = async () => {
  try {
    setLoginError("");
    const res = await fetch(`${API_BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loginForm),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || "Login failed");

    localStorage.setItem("auth_token", result.access_token);
    localStorage.setItem("auth_user", JSON.stringify(result.user));
    window.location.href = "/";
  } catch (err: any) {
    setLoginError(err.message || "Login failed");
  }
};

const handleLogout = () => {
  localStorage.removeItem("auth_token");
  localStorage.removeItem("auth_user");
  window.location.href = "/";
};

if (!authUser) {
  return (
    <LoginPage
      username={loginForm.username}
      password={loginForm.password}
      error={loginError}
      onChange={(field, value) => setLoginForm({ ...loginForm, [field]: value })}
      onSubmit={handleLogin}
    />
  );
}

  const [data, setData] = useState<DashboardResponse>(fallbackData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastRefreshLabel, setLastRefreshLabel] = useState("");

  // Everyone lands on their role's Home (Boss / Team Leader / "Mera Din")
  const [activeTab, setActiveTab] = useState<string>("home");

  useEffect(() => {
    if ((activeTab === "admin" || activeTab === "organization") && authUser?.role !== "admin") {
      setActiveTab("visit");
    }
  }, [activeTab, authUser]);

  const [clientStatusFilter, setClientStatusFilter] = useState<"all" | ClientStatus>(
    stored?.clientStatusFilter ?? "all"
  );
  const [selectedSalesPerson, setSelectedSalesPerson] = useState(
    stored?.selectedSalesPerson ?? "all"
  );
  const [selectedProducts, setSelectedProducts] = useState<string[]>(
    stored?.selectedProducts ?? []
  );
  const [displayUnit, setDisplayUnit] = useState<"bag" | "kg">(stored?.displayUnit ?? "bag");
  // V2: the dashboard always reads the database; Excel is only a way to import data
  const dataSource = "database" as const;
  const [importOpen, setImportOpen] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rpl-filters-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [selectedTeam, setSelectedTeam] = useState("");
  const [masterTeams, setMasterTeams] = useState<{ id: number; name: string }[]>([]);
  const [orgCities, setOrgCities] = useState<OrgTreeCity[]>([]);
  const [customerFocus, setCustomerFocus] = useState("");
  const [selectedCityId, setSelectedCityId] = useState<string>("all");
  const [selectedBranchId, setSelectedBranchId] = useState<string>("all");
  const [productDropdownOpen, setProductDropdownOpen] = useState(false);
  const [productDropdownDirection, setProductDropdownDirection] = useState<"down" | "up">("down");
  const [productSearch, setProductSearch] = useState(stored?.productSearch ?? "");
  const [topN, setTopN] = useState<number>(stored?.topN ?? 8);
  const [selectedMonth, setSelectedMonth] = useState<string>(stored?.selectedMonth ?? "all");
  const [viewMode, setViewMode] = useState<
    "compare" | "current_year" | "previous_year" | "current_month" | "previous_month"
  >(stored?.viewMode ?? "compare");
  const [yearScope, setYearScope] = useState<"ytd" | "full">(
  stored?.yearScope ?? "ytd"
  );
  const [clientSearch, setClientSearch] = useState(stored?.clientSearch ?? "");
  const [focusedClient, setFocusedClient] = useState<ClientDrilldownItem | null>(null);
  const [focusedProduct, setFocusedProduct] = useState<ProductDrilldownItem | null>(null);
  const [focusedScorecard, setFocusedScorecard] = useState<SalesScorecardItem | null>(null);
  const [pagination, setPagination] = useState<PaginationState>({
    clientPage: 1,
    productPage: 1,
    recoveryPage: 1,
  });

  const productDropdownRef = useRef<HTMLDivElement | null>(null);

  const tabs: { key: TabKey; label: string; icon: ReactNode }[] = [
    { key: "overview", label: "Overview", icon: <LayoutDashboard size={16} /> },
    { key: "clients", label: "Clients", icon: <UserRoundSearch size={16} /> },
    { key: "products", label: "Products", icon: <Package size={16} /> },
    { key: "team", label: "Sales Team", icon: <Briefcase size={16} /> },
    { key: "recovery", label: "Recovery", icon: <ShieldAlert size={16} /> },
    { key: "executive", label: "Executive", icon: <Sparkles size={16} /> },
    { key: "admin", label: "Admin", icon: <Shield size={16} /> },
    { key: "visit", label: "Visit Form", icon: <Briefcase size={16} /> },
    { key: "dataEntry", label: "Data Entry", icon: <Package size={16} /> },
    { key: "forecast", label: "Forecast", icon: <TrendingUp size={16} /> },
    { key: "productContribution", label: "Product Contribution", icon: <BarChart3 size={16} /> },
    { key: "organization", label: "Organization", icon: <Building2 size={16} /> },
    { key: "multiYear", label: "Multi-Year", icon: <Layers size={16} /> },
    { key: "planner", label: "Visit Planner", icon: <CalendarClock size={16} /> },
    { key: "customers", label: "Customer 360", icon: <Contact size={16} /> },
    { key: "home", label: "Home", icon: <House size={16} /> },
  ];

  const visibleTabs = tabs.filter((tab) => {
    if (tab.key === "admin" || tab.key === "organization") return isAdmin;
    if (canViewDashboards) return true;
    return ["home", "visit", "dataEntry", "planner", "customers"].includes(tab.key);
  });
  const visibleGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: visibleTabs.filter((t) => g.tabs.includes(t.key)),
  })).filter((g) => g.items.length > 0);
  const activeTabLabel =
    activeTab === "overview"
      ? "Sales Overview"
      : activeTab === "home"
      ? "Home"
      : tabs.find((t) => t.key === activeTab)?.label ?? "Dashboard";

  // City > Branch filter narrows the Team list (scope is enforced by the backend as well)
  const branchOptions = orgCities
    .filter((c) => selectedCityId === "all" || String(c.id) === selectedCityId)
    .flatMap((c) => c.branches.map((b) => ({ ...b, cityName: c.name })));
  const teamIdsInFilter = new Set(
    branchOptions
      .filter((b) => selectedBranchId === "all" || String(b.id) === selectedBranchId)
      .flatMap((b) => b.teams.map((t) => t.id))
  );
  const orgFilterActive = selectedCityId !== "all" || selectedBranchId !== "all";
  const visibleTeams = orgFilterActive ? masterTeams.filter((t) => teamIdsInFilter.has(t.id)) : masterTeams;
  const showFilterRail = canViewDashboards && FILTER_TABS.includes(activeTab) && !filtersCollapsed;
  const scopeLabel = selectedTeam
    ? selectedTeam
    : orgFilterActive
    ? `${visibleTeams.length} teams`
    : canViewAllTeams
    ? "All teams"
    : "All my teams";

  useEffect(() => {
    const payload = {
      activeTab,
      clientStatusFilter,
      selectedSalesPerson,
      selectedProducts,
      productSearch,
      topN,
      selectedMonth,
      viewMode,
      yearScope,
      clientSearch,
      displayUnit,
      dataSource,
      selectedTeam,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [
    activeTab,
    clientStatusFilter,
    selectedSalesPerson,
    selectedProducts,
    productSearch,
    topN,
    selectedMonth,
    viewMode,
    yearScope,
    clientSearch,
    displayUnit,
    dataSource,
    selectedTeam,
  ]);

  const applyDashboardData = (payload: Partial<DashboardResponse>) => {
    setData({
      ...fallbackData,
      ...payload,
      summary: { ...fallbackData.summary, ...(payload.summary ?? {}) },
      executive_summary: {
        ...fallbackData.executive_summary,
        ...(payload.executive_summary ?? {}),
      },
      target_summary: { ...fallbackData.target_summary, ...(payload.target_summary ?? {}) },
      metadata: { ...(payload.metadata ?? {}) },
    });
    setLastRefreshLabel(new Date().toLocaleString());
  };

  const resetUiState = () => {
    setSelectedProducts([]);
    setProductSearch("");
    setSelectedMonth("all");
    setViewMode("compare");
    setYearScope("ytd");
    setClientSearch("");
    setFocusedClient(null);
    setFocusedProduct(null);
    setFocusedScorecard(null);
    setPagination({ clientPage: 1, productPage: 1, recoveryPage: 1 });
    setDisplayUnit("bag");
    setSelectedTeam("");
    setSelectedCityId("all");
    setSelectedBranchId("all");
  };

  const fetchJson = async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

    let result: any = null;

    if (isJson) {
      result = await response.json();
    } else {
      const text = await response.text();
      result = { detail: text || "Unexpected non-JSON response" };
    }

    if (!response.ok) {
      throw new Error(result?.detail || "Request failed");
    }

    return result;
  };

  const loadMasterTeams = async () => {
    try {
      const result = await fetchJson(`${API_BASE_URL}/api/teams`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
        },
        cache: "no-store",
      });

      const teamsPayload = Array.isArray(result) ? result : result.teams || [];
      setMasterTeams(teamsPayload);
    } catch (err) {
      console.error("Teams load failed", err);
    }
  };

  const dashboardQuery = () => {
    if (selectedTeam) return `team=${encodeURIComponent(selectedTeam)}`;
    if (orgFilterActive) return `teams=${encodeURIComponent(visibleTeams.map((t) => t.name).join(","))}`;
    return "";
  };

  const loadDashboard = async () => {
    try {
      setLoading(true);
      setError("");
      if (orgFilterActive && !selectedTeam && visibleTeams.length === 0) {
        applyDashboardData({ ...fallbackData });
        setError("Is city/branch mein abhi koi team map nahi hui.");
        return;
      }
      const q = dashboardQuery();
      const result = await fetchJson(`${API_BASE_URL}/dashboard/db?${q ? `${q}&` : ""}_ts=${Date.now()}`, {
        cache: "no-store",
      });
      applyDashboardData(result);
      if (result?.metadata?.empty_state) {
        setError("Is selection ke liye abhi data available nahi hai.");
      }
    } catch (err: any) {
      const message = err.message || "API connect nahi hui";
      if (message.toLowerCase().includes("at least 2 years")) {
        setError("Comparison ke liye kam az kam 2 saal ka data chahiye.");
      } else if (message.toLowerCase().includes("no data found")) {
        setError("Is selection ke liye abhi data available nahi hai.");
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(false);
    if (!canViewDashboards) return; // members/leaders only use Field Operations
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeam, selectedCityId, selectedBranchId, masterTeams.length]);

  useEffect(() => {
    try {
      localStorage.setItem("rpl-filters-collapsed", filtersCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [filtersCollapsed]);

  useEffect(() => {
    loadMasterTeams();
    if (canViewDashboards) {
      apiJson<{ cities: OrgTreeCity[] }>("/api/v2/org/tree")
        .then((tree) => setOrgCities(tree.cities || []))
        .catch(() => setOrgCities([]));
    }
  }, []);

  useEffect(() => {
    if (selectedTeam && orgFilterActive && !visibleTeams.some((t) => t.name === selectedTeam)) {
      setSelectedTeam("");
    }
  }, [selectedCityId, selectedBranchId]);

  
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (productDropdownRef.current && !productDropdownRef.current.contains(event.target as Node)) {
        setProductDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setPagination({ clientPage: 1, productPage: 1, recoveryPage: 1 });
  }, [clientStatusFilter, selectedSalesPerson, selectedProducts, selectedMonth, clientSearch, topN]);

  const s = data.summary;
  const currentYearLabel = s.current_year || new Date().getFullYear();
  const previousYearLabel = s.previous_year || currentYearLabel - 1;

    const getViewValue = (previousValue: number, currentValue: number) => {
    if (viewMode === "previous_year" || viewMode === "previous_month") return previousValue;
    if (viewMode === "current_year" || viewMode === "current_month") return currentValue;
    return currentValue;
  };

    const getSelectedMonths = () => {
    if (selectedMonth !== "all") return [selectedMonth];

    if (viewMode === "compare") {
      return data.available_months;
    }
    

    if (yearScope === "full") {
      return data.chart
        .filter((row) =>
          viewMode === "previous_year" ? Number(row.previous || 0) > 0 : Number(row.current || 0) > 0
        )
        .map((row) => row.month);
    }

    return data.available_months;
  };

  const getMonthOptions = () => {
    if (viewMode === "previous_year" && yearScope === "full") {
      return data.chart
        .filter((row) => Number(row.previous || 0) > 0)
        .map((row) => row.month);
    }

    if (viewMode === "current_year" && yearScope === "full") {
      return data.chart
        .filter((row) => Number(row.current || 0) > 0)
        .map((row) => row.month);
    }

    return data.available_months;
  };

  const getViewLabel = () => {
    if (viewMode === "previous_year") return String(previousYearLabel);
    if (viewMode === "current_year") return String(currentYearLabel);
    if (viewMode === "previous_month") return `${previousYearLabel} ${selectedMonth}`;
    if (viewMode === "current_month") return `${currentYearLabel} ${selectedMonth}`;
    return "Comparison";
  };

  /*
  const summaryViewTotals = useMemo(() => {
    const months = getSelectedMonths();

    const previousTotal = data.chart
      .filter((row) => months.includes(row.month))
      .reduce((sum, row) => sum + Number(row.previous || 0), 0);

    const currentTotal = data.chart
      .filter((row) => months.includes(row.month))
      .reduce((sum, row) => sum + Number(row.current || 0), 0);

    const growthValue = getGrowthPercent(previousTotal, currentTotal);

    return {
      previousTotal,
      currentTotal,
      growthValue,
      months,
    };
  }, [data.chart, data.available_months, selectedMonth, viewMode, yearScope]);
  */

  const productOptions = useMemo(() => {
  return data.products.map((product) => product.name);
}, [data.products]);

const searchedProductOptions = useMemo(() => {
  if (!productSearch.trim()) return productOptions;

  const q = productSearch.trim().toLowerCase();
  return productOptions.filter((name) => name.toLowerCase().includes(q));
}, [productOptions, productSearch]);

const allProductsSelected = selectedProducts.length === productOptions.length;

const productSelectionLabel =
  selectedProducts.length === 0
    ? "All Products"
    : selectedProducts.length === productOptions.length
    ? "All Selected"
    : `${selectedProducts.length} selected`;
  
  const filteredProductDrilldown = useMemo(() => {
    let items =
      selectedProducts.length === 0
        ? data.product_drilldown
        : data.product_drilldown.filter((product) => selectedProducts.includes(product.name));

    if (selectedSalesPerson !== "all") {
      items = items.filter((product) => product.top_sales_person === selectedSalesPerson);
    }

    if (selectedMonth !== "all") {
      items = items.filter((product) => {
        const row = product.monthly_trend.find((m) => m.month === selectedMonth);
        return !!row && ((row.previous || 0) > 0 || (row.current || 0) > 0);
      });
    }

    return items;
  }, [data.product_drilldown, selectedProducts, selectedSalesPerson, selectedMonth]);

  const filteredTeam = useMemo(() => {
    return selectedSalesPerson === "all"
      ? data.team
      : data.team.filter((member) => member.name === selectedSalesPerson);
  }, [data.team, selectedSalesPerson]);

  const filteredScorecards = useMemo(() => {
    return selectedSalesPerson === "all"
      ? data.sales_scorecards
      : data.sales_scorecards.filter((member) => member.name === selectedSalesPerson);
  }, [data.sales_scorecards, selectedSalesPerson]);

  const scopedOverviewMonths = useMemo(() => getSelectedMonths(), [
    selectedMonth,
    viewMode,
    yearScope,
    data.available_months,
    data.chart,
  ]);

  const scopedOverviewChart = useMemo(() => {
    if (selectedSalesPerson === "all") {
      return data.chart.filter((item) => scopedOverviewMonths.includes(item.month));
    }

    const personTrend = data.salesperson_monthly_trend.find(
      (item) => item.name === selectedSalesPerson
    );

    if (!personTrend) {
      return scopedOverviewMonths.map((month) => ({
        month,
        previous: 0,
        current: 0,
      }));
    }

    return personTrend.monthly_trend.filter((item) =>
      scopedOverviewMonths.includes(item.month)
    );
  }, [selectedSalesPerson, data.chart, data.salesperson_monthly_trend, scopedOverviewMonths]);

  const scopedOverviewTotals = useMemo(() => {
    const previousTotal = scopedOverviewChart.reduce(
      (sum, row) => sum + Number(row.previous || 0),
      0
    );
    const currentTotal = scopedOverviewChart.reduce(
      (sum, row) => sum + Number(row.current || 0),
      0
    );
    const growthValue = getGrowthPercent(previousTotal, currentTotal);

    return {
      previousTotal,
      currentTotal,
      growthValue,
    };
  }, [scopedOverviewChart]);

  const metricPrimaryValue =
    viewMode === "previous_year" || viewMode === "previous_month"
      ? scopedOverviewTotals.previousTotal
      : scopedOverviewTotals.currentTotal;

  const metricGrowthValue = scopedOverviewTotals.growthValue;

  const overviewChartData = scopedOverviewChart;

  const overviewMonthComparison = useMemo(() => {
    return scopedOverviewChart.map((item) => ({
      month: item.month,
      previous: Number(item.previous || 0),
      current: Number(item.current || 0),
      growth_percent: getGrowthPercent(
        Number(item.previous || 0),
        Number(item.current || 0)
      ),
      delta: Number(item.current || 0) - Number(item.previous || 0),
    }));
  }, [scopedOverviewChart]);

  const scopedClientSummary = useMemo(() => {
    const scopedClients =
      selectedSalesPerson === "all"
        ? data.client_drilldown
        : data.client_drilldown.filter(
          (client) => client.assigned_sales_person === selectedSalesPerson
        );

    const retained = scopedClients.filter((c) => c.status === "retained").length;
    const lost = scopedClients.filter((c) => c.status === "lost").length;
    const newlyAdded = scopedClients.filter((c) => c.status === "new").length;

    const retainedBase = retained + lost;
    const retainedRate = retainedBase > 0 ? (retained / retainedBase) * 100 : 0;

    return {
      retained,
      lost,
      newClients: newlyAdded,
      retainedRate,
    };
  }, [selectedSalesPerson, data.client_drilldown]);

  const scopedTopProduct = useMemo(() => {
    if (selectedSalesPerson === "all") return s.top_product;

    const scopedProducts = data.product_drilldown.filter(
      (product) => product.top_sales_person === selectedSalesPerson
    );

    return getTopProductFromProducts(scopedProducts);
  }, [selectedSalesPerson, data.product_drilldown, s.top_product]);

  const filteredClientDrilldown = useMemo(() => {
    let items = [...data.client_drilldown];

    if (clientStatusFilter !== "all") {
      items = items.filter((item) => item.status === clientStatusFilter);
    }
    if (selectedSalesPerson !== "all") {
      items = items.filter((item) => item.assigned_sales_person === selectedSalesPerson);
    }
    if (selectedProducts.length > 0) {
      items = items.filter((item) => selectedProducts.includes(item.dominant_product));
    }
    if (selectedMonth !== "all") {
      items = items.filter((item) => {
        const row = item.monthly_trend.find((m) => m.month === selectedMonth);
        return !!row && ((row.previous || 0) > 0 || (row.current || 0) > 0);
      });
    }
    if (clientSearch.trim()) {
      const q = clientSearch.trim().toLowerCase();
      items = items.filter((item) => item.name.toLowerCase().includes(q));
    }

    return items.sort((a, b) => {
      const aRow =
        selectedMonth === "all"
          ? null
          : a.monthly_trend.find((m) => m.month === selectedMonth);
      const bRow =
        selectedMonth === "all"
          ? null
          : b.monthly_trend.find((m) => m.month === selectedMonth);

      const aValue =
        selectedMonth === "all"
          ? Math.max(a.previous_year_quantity, a.current_year_quantity)
          : Math.max(aRow?.previous || 0, aRow?.current || 0);

      const bValue =
        selectedMonth === "all"
          ? Math.max(b.previous_year_quantity, b.current_year_quantity)
          : Math.max(bRow?.previous || 0, bRow?.current || 0);

      return bValue - aValue;
    });
  }, [
    data.client_drilldown,
    clientStatusFilter,
    selectedSalesPerson,
    selectedProducts,
    selectedMonth,
    clientSearch,
  ]);

  const filteredNewClientQuality = useMemo(() => {
    let items = [...data.new_client_quality];
    if (selectedSalesPerson !== "all") {
      items = items.filter((item) => item.sales_person === selectedSalesPerson);
    }
    if (selectedProducts.length > 0) {
      items = items.filter((item) =>
        item.product_mix.some((mix) => selectedProducts.includes(mix.product))
      );
    }
    if (selectedMonth !== "all") {
      items = items.filter((item) => item.first_active_month === selectedMonth);
    }
    return items.sort((a, b) => b.quantity - a.quantity);
  }, [data.new_client_quality, selectedSalesPerson, selectedProducts, selectedMonth]);

  const topFiveProducts = useMemo(() => {
    return [...filteredProductDrilldown]
      .map((item) => {
        if (selectedMonth === "all") {
          return {
            name: item.name,
            sales: item.this_year_sales,
            share: 0,
          };
        }

        const row = item.monthly_trend.find((m) => m.month === selectedMonth);
        return {
          name: item.name,
          sales: row?.current || 0,
          share: 0,
        };
      })
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5);
  }, [filteredProductDrilldown, selectedMonth]);

  const selectedProductCard = useMemo(() => {
    if (focusedProduct) return focusedProduct;
    if (selectedProducts.length === 1) {
      return data.product_drilldown.find((item) => item.name === selectedProducts[0]) ?? null;
    }
    return null;
  }, [focusedProduct, selectedProducts, data.product_drilldown]);

  const selectedScorecard = useMemo(() => {
    if (focusedScorecard) return focusedScorecard;
    if (selectedSalesPerson === "all") return null;
    return data.sales_scorecards.find((item) => item.name === selectedSalesPerson) ?? null;
  }, [focusedScorecard, selectedSalesPerson, data.sales_scorecards]);

  const scopedBestMonth = useMemo(() => {
    if (!scopedOverviewChart.length) return null;

    return [...scopedOverviewChart]
      .map((item) => ({
        ...item,
        growth_percent: getGrowthPercent(
          Number(item.previous || 0),
          Number(item.current || 0)
        ),
        delta: Number(item.current || 0) - Number(item.previous || 0),
      }))
      .sort((a, b) => b.growth_percent - a.growth_percent)[0];
  }, [scopedOverviewChart]);

  const scopedWorstMonth = useMemo(() => {
    if (!scopedOverviewChart.length) return null;

    return [...scopedOverviewChart]
      .map((item) => ({
        ...item,
        growth_percent: getGrowthPercent(
          Number(item.previous || 0),
          Number(item.current || 0)
        ),
        delta: Number(item.current || 0) - Number(item.previous || 0),
      }))
      .sort((a, b) => a.growth_percent - b.growth_percent)[0];
  }, [scopedOverviewChart]);

  const bestMonth = scopedBestMonth;
  const worstMonth = scopedWorstMonth;

  const bestSalesPerson = useMemo(() => {
    if (!data.team.length) return null;
    return [...data.team].sort((a, b) => b.change_percent - a.change_percent)[0];
  }, [data.team]);

  const insightCards = useMemo<InsightItem[]>(() => {
    const items: InsightItem[] = [];
    if (bestMonth) {
      items.push({
        title: `Best Month: ${bestMonth.month}`,
        description: `${formatPercent(bestMonth.growth_percent)} vs ${previousYearLabel}`,
        tone: bestMonth.growth_percent >= 0 ? "positive" : "warning",
      });
    }
    if (worstMonth) {
      items.push({
        title: `Watch Month: ${worstMonth.month}`,
        description: `${formatPercent(worstMonth.growth_percent)} is the weakest point`,
        tone: worstMonth.growth_percent < 0 ? "negative" : "neutral",
      });
    }
    if (bestSalesPerson && !isSuperUser) {
      items.push({
        title: `Top Gainer: ${bestSalesPerson.name}`,
        description: `${formatPercent(bestSalesPerson.change_percent)} performance change`,
        tone: bestSalesPerson.change_percent >= 0 ? "positive" : "warning",
      });
    }
    items.push({
      title: "Retention Base",
      description: `${scopedClientSummary.retained} retained clients | ${Number(
        scopedClientSummary.retainedRate || 0
      ).toFixed(1)}%`,
      tone: "neutral",
    });
    items.push({
      title: "Concentration Risk",
      description: `${Number(s.product_concentration_risk || 0).toFixed(1)}% top product share`,
      tone: Number(s.product_concentration_risk || 0) >= 45 ? "warning" : "neutral",
    });
    items.push({
      title: "Lost vs New",
      description: `${scopedClientSummary.lost} lost | ${scopedClientSummary.newClients} new`,
      tone:
        scopedClientSummary.lost > scopedClientSummary.newClients
          ? "negative"
          : "positive",
    });
    return items.slice(0, 6);
  }, [
    bestMonth,
    worstMonth,
    bestSalesPerson,
    previousYearLabel,
    s,
    scopedClientSummary,
  ]);

  const concentrationData = useMemo(
    () => topFiveProducts.map((product, index) => ({ ...product, index })),
    [topFiveProducts]
  );

  const activeFilterChips = useMemo(() => {
    const chips: { key: string; label: string; onClear: () => void }[] = [];
    if (selectedCityId !== "all") {
      chips.push({
        key: "city",
        label: `City: ${orgCities.find((c) => String(c.id) === selectedCityId)?.name ?? selectedCityId}`,
        onClear: () => {
          setSelectedCityId("all");
          setSelectedBranchId("all");
        },
      });
    }
    if (selectedBranchId !== "all") {
      const b = orgCities.flatMap((c) => c.branches).find((x) => String(x.id) === selectedBranchId);
      chips.push({ key: "branch", label: `Branch: ${b?.name ?? selectedBranchId}`, onClear: () => setSelectedBranchId("all") });
    }
    if (selectedTeam) {
      chips.push({ key: "team", label: `Team: ${selectedTeam}`, onClear: () => setSelectedTeam("") });
    }
    if (selectedSalesPerson !== "all") {
      chips.push({
        key: "sales",
        label: `Sales: ${selectedSalesPerson}`,
        onClear: () => setSelectedSalesPerson("all"),
      });
    }
    if (clientStatusFilter !== "all") {
      chips.push({
        key: "status",
        label: `Status: ${clientStatusFilter}`,
        onClear: () => setClientStatusFilter("all"),
      });
    }
    if (selectedMonth !== "all") {
      chips.push({
        key: "month",
        label: `Month: ${selectedMonth}`,
        onClear: () => setSelectedMonth("all"),
      });
    }
    if (viewMode !== "compare" && viewMode !== "current_month" && viewMode !== "previous_month") {
      chips.push({
        key: "yearScope",
        label: `Scope: ${yearScope.toUpperCase()}`,
        onClear: () => setYearScope("ytd"),
      });
    }
    if (selectedProducts.length > 0) {
      chips.push({
        key: "products",
        label: `Products: ${selectedProducts.length}`,
        onClear: () => setSelectedProducts([]),
      });
    }
    if (clientSearch.trim()) {
      chips.push({
        key: "search",
        label: `Client: ${clientSearch}`,
        onClear: () => setClientSearch(""),
      });
    }
    return chips;
  }, [
    selectedCityId,
    selectedBranchId,
    selectedTeam,
    orgCities,
    selectedSalesPerson,
    clientStatusFilter,
    selectedMonth,
    selectedProducts,
    clientSearch,
    viewMode,
    yearScope,
  ]);

  const pagedClientDrilldown = useMemo(
    () => slicePage(filteredClientDrilldown, pagination.clientPage),
    [filteredClientDrilldown, pagination.clientPage]
  );
  const pagedProductDrilldown = useMemo(
    () => slicePage(filteredProductDrilldown, pagination.productPage),
    [filteredProductDrilldown, pagination.productPage]
  );
  const pagedRecovery = useMemo(
    () => slicePage(data.lost_client_recovery, pagination.recoveryPage),
    [data.lost_client_recovery, pagination.recoveryPage]
  );

  const clearAllFilters = () => {
    resetUiState();
  };

  const toggleProductSelection = (productName: string) => {
    setSelectedProducts((prev) =>
      prev.includes(productName)
        ? prev.filter((name) => name !== productName)
        : [...prev, productName]
    );
  };

  const toggleAllProducts = () => {
    setSelectedProducts((prev) =>
      prev.length === productOptions.length ? [] : [...productOptions]
    );
  };

  const exportPdf = () => window.print();
  
  const getReportSubtitle = () => {
    const salesText = selectedSalesPerson === "all" ? "All Sales Persons" : selectedSalesPerson;
    const productText = selectedProducts.length === 0 ? "All Products" : `${selectedProducts.length} Products`;
    const monthText = selectedMonth === "all" ? "All Months" : selectedMonth;
    const teamText = selectedTeam || "All Teams";

    return `Team: ${teamText} | Sales Person: ${salesText} | Month: ${monthText} | Products: ${productText} | View: ${getViewLabel()}`;
  };

  const downloadClientDrilldownPdf = async () => {
    try {
      if (!filteredClientDrilldown.length) {
        alert("PDF ke liye koi client data available nahi hai.");
        return;
      }

      const { jsPDF } = await loadPdf();
      const doc = new jsPDF("l", "mm", "a4");

      doc.setFontSize(16);
      doc.text("Client Drilldown Report", 14, 14);

      doc.setFontSize(9);
      doc.text(getReportSubtitle(), 14, 22);
      doc.text(`Total Clients: ${filteredClientDrilldown.length}`, 14, 28);

      const rows = filteredClientDrilldown.map((client) => {
        const monthRow =
          selectedMonth === "all"
            ? null
            : client.monthly_trend.find((m) => m.month === selectedMonth);

        const previousValue =
          selectedMonth === "all"
            ? client.previous_year_quantity
            : monthRow?.previous || 0;

        const currentValue =
          selectedMonth === "all"
            ? client.current_year_quantity
            : monthRow?.current || 0;

        const deltaValue = currentValue - previousValue;

        return [
          client.name,
          client.status,
          client.assigned_sales_person,
          client.dominant_product,
          formatNumber(previousValue),
          formatNumber(currentValue),
          formatNumber(deltaValue),
        ];
      });

      (doc as any).autoTable({
        startY: 34,
        head: [
          [
            "Client",
            "Status",
            "Sales Person",
            "Product",
            String(previousYearLabel),
            String(currentYearLabel),
            "Delta",
          ],
        ],
        body: rows,
        styles: {
          fontSize: 7,
          cellPadding: 2,
        },
        headStyles: {
          fillColor: [30, 64, 175],
          textColor: 255,
        },
      });

      doc.save("client-drilldown-report.pdf");
    } catch (err: any) {
      console.error("Client PDF failed:", err);
      alert(err?.message || "Client PDF generate nahi hui.");
    }
  };

  const downloadProductIntelligencePdf = async () => {
    try {
      if (!filteredProductDrilldown.length) {
        alert("PDF ke liye koi product data available nahi hai.");
        return;
      }

      const { jsPDF } = await loadPdf();
      const doc = new jsPDF("l", "mm", "a4");

      doc.setFontSize(16);
      doc.text("Product Intelligence Report", 14, 14);

      doc.setFontSize(9);
      doc.text(getReportSubtitle(), 14, 22);
      doc.text(`Total Products: ${filteredProductDrilldown.length}`, 14, 28);

      const rows = filteredProductDrilldown.map((product) => {
        const monthRow =
          selectedMonth === "all"
            ? null
            : product.monthly_trend.find((m) => m.month === selectedMonth);

        const previousValue =
          selectedMonth === "all"
            ? product.last_year_sales
            : monthRow?.previous || 0;

        const currentValue =
          selectedMonth === "all"
            ? product.this_year_sales
            : monthRow?.current || 0;

        const deltaValue = currentValue - previousValue;
        const growthValue = getGrowthPercent(previousValue, currentValue);

        return [
          product.name,
          formatNumber(previousValue),
          formatNumber(currentValue),
          formatNumber(deltaValue),
          formatPercent(growthValue),
          String(product.client_count),
          product.top_sales_person,
        ];
      });

      (doc as any).autoTable({
        startY: 34,
        head: [
          [
            "Product",
            String(previousYearLabel),
            String(currentYearLabel),
            "Delta",
            "Growth",
            "Clients",
            "Top Sales Person",
          ],
        ],
        body: rows,
        styles: {
          fontSize: 7,
          cellPadding: 2,
        },
        headStyles: {
          fillColor: [30, 64, 175],
          textColor: 255,
        },
      });

      doc.save("product-intelligence-report.pdf");
    } catch (err: any) {
      console.error("Product PDF failed:", err);
      alert(err?.message || "Product PDF generate nahi hui.");
    }
  };

  const renderPagination = (
    page: number,
    pageCount: number,
    onChange: (nextPage: number) => void
  ) => {
    if (pageCount <= 1) return null;
    return (
      <div className="pagination-bar">
        <button className="pagination-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </button>
        <span className="pagination-label">
          Page {page} / {pageCount}
        </span>
        <button className="pagination-btn" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    );
  };

  const renderOverviewTab = () => {
    const selectedMonthsLabel =
      selectedMonth !== "all"
        ? selectedMonth
        : viewMode === "compare"
        ? "Same Available Months"
        : yearScope === "full"
        ? "Full Year"
        : "YTD / Same Months";

    return (
      <>
        <div className="metrics-grid">
          <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-1"><Package /></span>
                <span className="v2-kpi-arrow"><ArrowUpRight /></span>
              </div>
            <p className="metric-title">
              {viewMode === "previous_year" || viewMode === "previous_month"
                ? `${previousYearLabel} Bags`
                : `${currentYearLabel} Bags`}
            </p>
            <h3 className="metric-value">{formatWithUnit(metricPrimaryValue, displayUnit)}</h3>
            <p className="metric-sub positive">{selectedMonthsLabel}</p>
          </div>

          <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-4"><CalendarRange /></span>
                <span className="v2-kpi-arrow"><ArrowUpRight /></span>
              </div>
            <p className="metric-title">
              {viewMode === "compare"
                ? `${previousYearLabel} Same Period`
                : "Comparison Base"}
            </p>
            <h3 className="metric-value">
              {formatWithUnit(scopedOverviewTotals.previousTotal, displayUnit)}
            </h3>
            <p className="metric-sub positive">
              {viewMode === "compare"
                ? "Like-for-like comparison"
                : `${previousYearLabel} selected months`}
            </p>
          </div>

          <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-2"><TrendingUp /></span>
                <span className="v2-kpi-arrow"><ArrowUpRight /></span>
              </div>
            <p className="metric-title">Growth</p>
            <h3 className="metric-value">
              {formatMeaningfulGrowth(
                scopedOverviewTotals.previousTotal,
                scopedOverviewTotals.currentTotal,
                metricGrowthValue
              )}
            
            </h3>
            <p className={`metric-sub ${metricGrowthValue < 0 ? "negative" : "positive"}`}>
              {selectedMonthsLabel} trend
            </p>
          </div>

          <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-3"><Users /></span>
                <span className="v2-kpi-arrow"><ArrowUpRight /></span>
              </div>
            <p className="metric-title">Retained Clients</p>
            <h3 className="metric-value">
              {formatNumber(scopedClientSummary.retained)} Clients
            </h3>
            <p className="metric-sub positive">
              {Number(scopedClientSummary.retainedRate || 0).toFixed(1)}% retained rate
            </p>
          </div>

          <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-1"><Sparkles /></span>
                <span className="v2-kpi-arrow"><ArrowUpRight /></span>
              </div>
            <p className="metric-title">Top Product</p>
            <h3 className="metric-value metric-value-sm">
              {scopedTopProduct && scopedTopProduct.toLowerCase() !== "nan" ? scopedTopProduct : "N/A"}
            </h3>
            <p className="metric-sub positive">Leading current mix</p>
          </div>

          {!isSuperUser ? (
            <div className="card metric-card">
              <div className="v2-kpi-head">
                <span className="v2-kpi-icon tone-2"><Briefcase /></span>
                <span className="v2-kpi-arrow"><ArrowUpRight /></span>
              </div>
              <p className="metric-title">Top Sales Person</p>
              <h3 className="metric-value metric-value-sm">
                {selectedSalesPerson === "all"
                  ? (s.top_sales_person && s.top_sales_person.toLowerCase() !== "nan"
                      ? s.top_sales_person
                      : "N/A")
                  : selectedSalesPerson}
              </h3>
              <p className="metric-sub positive">
                {selectedSalesPerson === "all"
                  ? "Strongest YTD performer"
                  : "Selected sales person"}
              </p>
            </div>
          ) : null}
        </div>

        <div className="smart-insights-grid">
          {insightCards.map((item, index) => (
            <div
              key={`${item.title}-${index}`}
              className={`insight-card insight-${item.tone}`}
            >
              <strong>{item.title}</strong>
              <p>{item.description}</p>
            </div>
          ))}
        </div>

        <div className="top-grid">
          <div className="card">
            <div className="section-head">
              <div>
                <h2>Month Wise YTD Trend</h2>
                <p className="section-subtext">
                  Overview focused on fast scanning and cleaner performance
                </p>
              </div>
            </div>

            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={overviewChartData}>
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart.accent} stopOpacity={0.45} />
                      <stop offset="95%" stopColor={chart.accent} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chart.muted} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={chart.muted} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>

                  <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                  <XAxis dataKey="month" {...axisProps} />
                  <YAxis {...axisProps} width={48} />
                  <Tooltip {...tooltipProps} />
                  <Legend />

                  {(viewMode === "compare" ||
                    viewMode === "current_year" ||
                    viewMode === "current_month") && (
                    <Area
                      type="monotone"
                      dataKey="current"
                      name={String(currentYearLabel)}
                      stroke={chart.accent}
                      strokeWidth={3}
                      fill="url(#g1)"
                      activeDot={{ r: 6, strokeWidth: 3, stroke: chart.tooltipBg, fill: chart.accent }}
                      animationDuration={1100}
                    />
                  )}

                  {(viewMode === "compare" ||
                    viewMode === "previous_year" ||
                    viewMode === "previous_month") && (
                    <Area
                      type="monotone"
                      dataKey="previous"
                      name={String(previousYearLabel)}
                      stroke={chart.muted}
                      strokeWidth={2}
                      strokeDasharray="6 5"
                      fill="url(#g2)"
                      animationDuration={1100}
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="month-chip-row">
              <button
                className={`month-chip ${selectedMonth === "all" ? "active" : ""}`}
                onClick={() => {
                  setSelectedMonth("all");
                  setViewMode("compare");
                }}
              >
                All
              </button>

              {data.available_months.map((month) => (
                <button
                  key={month}
                  className={`month-chip ${selectedMonth === month ? "active" : ""}`}
                  onClick={() => {
                    setSelectedMonth(month);
                  }}
                >
                  {month}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="section-head">
              <div>
                <h2>Alerts / Exception Engine</h2>
                <p className="section-subtext">
                  The dashboard should proactively identify and highlight issues that need attention.
                </p>
              </div>
            </div>

            <div className="stack-grid">
              {data.alerts.length === 0 ? (
                <div className="empty-lite">No alerts available</div>
              ) : (
                data.alerts
                  .filter((alert) => !isSuperUser || alert.title !== "Sales coaching target")
                  .slice(0, 4)
                  .map((alert, index) => (
                  <div key={`${alert.title}-${index}`} className={getAlertClass(alert.severity)}>
                    <div className="row-inline">
                      <Siren size={15} />
                      <strong>{alert.title}</strong>
                    </div>
                    <p>{alert.message}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h2>Month Wise Comparison</h2>
              <p className="section-subtext">
                Click any month and continue drilldown in Clients or Products
              </p>
            </div>
          </div>

          <div className="month-list-grid">
            {overviewMonthComparison.map((item) => (
              <button
                key={item.month}
                className="list-box interactive-box"
                onClick={() => setSelectedMonth(item.month)}
              >
                <div className="row-between">
                  <strong>{item.month}</strong>
                  <span className={item.growth_percent < 0 ? "negative" : "positive"}>
                    {formatPercent(item.growth_percent)}
                  </span>
                </div>
                <p>{previousYearLabel}: {formatNumber(item.previous)}</p>
                <p>{currentYearLabel}: {formatNumber(item.current)}</p>
                <p>Delta: {formatNumber(item.delta || 0)}</p>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  };

  const renderClientsTab = () => (
    <>
      <div className="drilldown-grid">
        <div className="card">
          <div className="section-head">
            <div>
              <h2>Client Drilldown</h2>
              <p className="section-subtext">Kaunsa client kis product me gira ya grow hua</p>
            </div>
            <span className="soft-counter">{filteredClientDrilldown.length} clients</span>
            <button
              type="button"
              className="ai-export-btn"
              onClick={downloadClientDrilldownPdf}
            >
              <Download size={14} />
              PDF
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Sales Person</th>
                  <th>Product</th>
                  {viewMode === "compare" ? (
                    <>
                      <th>{previousYearLabel}</th>
                      <th>{currentYearLabel}</th>
                      <th>Delta</th>
                    </>
                  ) : (
                    <th colSpan={3}>{getViewLabel()}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {pagedClientDrilldown.items.map((client) => {
                  const monthRow =
                    selectedMonth === "all"
                      ? null
                      : client.monthly_trend.find((m) => m.month === selectedMonth);

                  const previousValue =
                    selectedMonth === "all"
                      ? client.previous_year_quantity
                      : monthRow?.previous || 0;

                  const currentValue =
                    selectedMonth === "all"
                      ? client.current_year_quantity
                      : monthRow?.current || 0;

                  const deltaValue = currentValue - previousValue;
                  const displayValue = getViewValue(previousValue, currentValue);

                  return (
                    <tr key={client.name} onClick={() => setFocusedClient(client)}>
                      <td>{client.name}</td>
                      <td><span className={getBadgeClass(client.status)}>{client.status}</span></td>
                      <td>{client.assigned_sales_person}</td>
                      <td>{client.dominant_product}</td>
                      {viewMode === "compare" ? (
                        <>
                          <td>{formatWithUnit(previousValue, displayUnit)}</td>
                          <td>{formatWithUnit(currentValue, displayUnit)}</td>
                          <td className={deltaValue < 0 ? "negative" : "positive"}>
                            {formatWithUnit(deltaValue, displayUnit)}
                          </td>
                        </>
                      ) : (
                        <>
                          <td colSpan={3}>{getViewLabel()}: {formatNumber(displayValue)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {renderPagination(pagedClientDrilldown.page, pagedClientDrilldown.pageCount, (next) =>
            setPagination((prev) => ({ ...prev, clientPage: next }))
          )}
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h2>Selected Client</h2>
              <p className="section-subtext">Monthly trend and ownership context</p>
            </div>
          </div>
          {focusedClient ? (() => {
            const monthRow =
              selectedMonth === "all"
                ? null
                : focusedClient.monthly_trend.find((m) => m.month === selectedMonth);

            const previousValue =
              selectedMonth === "all"
                ? focusedClient.previous_year_quantity
                : monthRow?.previous || 0;

            const currentValue =
              selectedMonth === "all"
                ? focusedClient.current_year_quantity
                : monthRow?.current || 0;

            return (
              <>
                <div className="focus-box">
                  <div className="row-between">
                    <strong>{focusedClient.name}</strong>
                    <span className={getBadgeClass(focusedClient.status)}>{focusedClient.status}</span>
                  </div>
                  <p>Sales person: <strong>{focusedClient.assigned_sales_person}</strong></p>
                  <p>Product: <strong>{focusedClient.dominant_product}</strong></p>
                  <p>{previousYearLabel}: <strong>{formatWithUnit(previousValue, displayUnit)}</strong></p>
                  <p>{currentYearLabel}: <strong>{formatWithUnit(currentValue, displayUnit)}</strong></p>
                </div>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={focusedClient.monthly_trend}>
                      <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                      <XAxis dataKey="month" {...axisProps} />
                      <YAxis {...axisProps} width={48} />
                      <Tooltip {...tooltipProps} />
                      <Legend />
                      <Line type="monotone" dataKey="previous" name={String(previousYearLabel)} stroke={chart.muted} strokeWidth={2} strokeDasharray="6 5" dot={false} animationDuration={1000} />
                      <Line type="monotone" dataKey="current" name={String(currentYearLabel)} stroke={chart.accent} strokeWidth={3} dot={{ r: 3, fill: chart.accent, strokeWidth: 0 }} activeDot={{ r: 6, strokeWidth: 3, stroke: chart.tooltipBg }} animationDuration={1000} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            );
          })() : (
            <div className="empty-state">Select any client from the table</div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2>New Client Quality Check</h2>
            <p className="section-subtext">Trial order vs meaningful acquisition</p>
          </div>
        </div>
        <div className="product-grid">
          {filteredNewClientQuality.slice(0, topN).map((item) => (
            <div className="mini-card" key={item.client_name}>
              <div className="row-between">
                <strong>{item.client_name}</strong>
                <span className={getBadgeClass(item.quality_label)}>{item.quality_label}</span>
              </div>
              <p>First month: {item.first_active_month}</p>
              <p>Sales person: {item.sales_person}</p>
              <p>Qty: {formatNumber(item.quantity)}</p>
              <p>Mix: {item.product_mix.slice(0, 2).map((m) => m.product).join(", ") || "N/A"}</p>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  const renderProductsTab = () => (
    <>
      <div className="analytics-grid">
        <div className="card">
          <div className="section-head">
            <div>
              <h2>Top Selected Products</h2>
              <p className="section-subtext">Top 5 products from current selected view</p>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={topFiveProducts} barCategoryGap="28%">
                <defs>
                  <linearGradient id="v2BarGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chart.accentLight} />
                    <stop offset="100%" stopColor={chart.accent} stopOpacity={0.55} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                <XAxis dataKey="name" hide />
                <YAxis {...axisProps} width={48} />
                <Tooltip {...tooltipProps} />
                <Bar
                  dataKey="sales"
                  radius={[12, 12, 4, 4]}
                  fill="url(#v2BarGrad)"
                  animationDuration={900}
                  onClick={(entry: any) => {
                    const match = data.product_drilldown.find((item) => item.name === entry?.name);
                    if (match) {
                      setFocusedProduct(match);
                      setSelectedProducts([match.name]);
                    }
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h2>Product Share Mix</h2>
              <p className="section-subtext">Concentration and concentration risk view</p>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={concentrationData}
                  innerRadius={64}
                  outerRadius={98}
                  paddingAngle={4}
                  cornerRadius={8}
                  stroke="none"
                  animationDuration={1000}
                  dataKey="sales"
                  nameKey="name"
                >
                  {concentrationData.map((entry, index) => (
                    <Cell
                      key={`${entry.name}-${index}`}
                      fill={chart.series[index % chart.series.length]}
                    />
                  ))}
                </Pie>
                <Tooltip {...tooltipProps} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <p className="metric-title">Fastest Growing Product</p>
          <h3 className="metric-value metric-value-sm">{s.fastest_growing_product || "N/A"}</h3>
          <p className="metric-sub positive">Quiet opportunity</p>
          <div className="divider" />
          <p className="metric-title">Declining Product</p>
          <h3 className="metric-value metric-value-sm">{s.declining_product || "N/A"}</h3>
          <p className="metric-sub negative">Needs attention</p>
          <div className="divider" />
          <p className="metric-title">Concentration Risk</p>
          <h3 className="metric-value">{Number(s.product_concentration_risk || 0).toFixed(1)}%</h3>
          <p className="metric-sub">Top product share</p>
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2>Product Intelligence</h2>
            <p className="section-subtext">Product-wise monthly trend, client count, and owner</p>
          </div>
          <button
            type="button"
            className="ai-export-btn"
            onClick={downloadProductIntelligencePdf}
          >
            <Download size={14} />
            PDF
          </button>
        </div>
        <div className="product-grid">
          {pagedProductDrilldown.items.map((product) => {
            const monthRow =
              selectedMonth === "all"
                ? null
                : product.monthly_trend.find((m) => m.month === selectedMonth);

            const previousValue =
              selectedMonth === "all"
                ? product.last_year_sales
                : monthRow?.previous || 0;

            const currentValue =
              selectedMonth === "all"
                ? product.this_year_sales
                : monthRow?.current || 0;

            const growthValue = getGrowthPercent(previousValue, currentValue);

            return (
              <button
                className="mini-card interactive-box left-align"
                key={product.name}
                onClick={() => setFocusedProduct(product)}
              >
                <div className="row-between">
                  <strong>{product.name}</strong>
                  <span className={growthValue < 0 ? "negative" : "positive"}>
                    {formatPercent(growthValue)}
                  </span>
                </div>
                <p>{previousYearLabel}: {formatWithUnit(previousValue, displayUnit)}</p>
                <p>{currentYearLabel}: {formatWithUnit(currentValue, displayUnit)}</p>
                <p>Clients: {product.client_count}</p>
                <p>Top sales person: {product.top_sales_person}</p>
              </button>
            );
          })}
        </div>
        {renderPagination(pagedProductDrilldown.page, pagedProductDrilldown.pageCount, (next) =>
          setPagination((prev) => ({ ...prev, productPage: next }))
        )}
      </div>

      {selectedProductCard && (() => {
        const monthRow =
          selectedMonth === "all"
            ? null
            : selectedProductCard.monthly_trend.find((m) => m.month === selectedMonth);

        const previousValue =
          selectedMonth === "all"
            ? selectedProductCard.last_year_sales
            : monthRow?.previous || 0;

        const currentValue =
          selectedMonth === "all"
            ? selectedProductCard.this_year_sales
            : monthRow?.current || 0;

        const growthValue = getGrowthPercent(previousValue, currentValue);

        return (
          <div className="card">
            <div className="section-head">
              <div>
                <h2>Selected Product Drilldown</h2>
                <p className="section-subtext">Deep view for clicked product</p>
              </div>
            </div>
            <div className="selected-product-grid">
              <div className="focus-box">
                <div className="row-between">
                  <strong>{selectedProductCard.name}</strong>
                  <span className={growthValue < 0 ? "negative" : "positive"}>
                    {formatPercent(growthValue)}
                  </span>
                </div>
                <p>{previousYearLabel}: <strong>{formatWithUnit(previousValue, displayUnit)}</strong></p>
                <p>{currentYearLabel}: <strong>{formatWithUnit(currentValue, displayUnit)}</strong></p>
                <p>Client count: <strong>{selectedProductCard.client_count}</strong></p>
                <p>Top sales person: <strong>{selectedProductCard.top_sales_person}</strong></p>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={selectedProductCard.monthly_trend}>
                    <CartesianGrid strokeDasharray="4 6" stroke={chart.grid} vertical={false} />
                    <XAxis dataKey="month" {...axisProps} />
                    <YAxis {...axisProps} width={48} />
                    <Tooltip {...tooltipProps} />
                    <Legend />
                    <Line type="monotone" dataKey="previous" name={String(previousYearLabel)} stroke={chart.muted} strokeWidth={2} strokeDasharray="6 5" dot={false} animationDuration={1000} />
                    <Line type="monotone" dataKey="current" name={String(currentYearLabel)} stroke={chart.accent} strokeWidth={3} dot={{ r: 3, fill: chart.accent, strokeWidth: 0 }} activeDot={{ r: 6, strokeWidth: 3, stroke: chart.tooltipBg }} animationDuration={1000} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );

  const renderTeamTab = () => (
    <>
      <div className="card">
        <div className="section-head">
          <div>
            <h2>Sales Person Performance Scorecard</h2>
            <p className="section-subtext">Kaun growth la raha, kaun clients lose kar raha</p>
          </div>
        </div>
        <div className="scorecard-grid">
          {filteredScorecards.map((item) => (
            <article
              key={item.name}
              className={`scorecard ${selectedScorecard?.name === item.name ? "active" : ""}`}
              onClick={() => {
                setFocusedScorecard(item);
                setSelectedSalesPerson(item.name);
              }}
            >
              <div className="row-between">
                <strong>{item.name}</strong>
                <span
                  className={
                    item.last_year === 0 && item.this_year > 0
                      ? "neutral"
                      : item.change_percent < 0
                      ? "negative"
                      : "positive"
                  }
                >
                  {formatMeaningfulGrowth(item.last_year, item.this_year, item.change_percent)}
                </span>
              </div>
              <div className="scorecard-mini-grid">
                <div className="mini-highlight"><span className="mini-label">This Year</span><strong>{formatNumber(item.this_year)}</strong></div>
                <div className="mini-highlight"><span className="mini-label">Last Year</span><strong>{formatNumber(item.last_year)}</strong></div>
                <div className="mini-highlight"><span className="mini-label">Active Clients</span><strong>{item.active_clients}</strong></div>
                <div className="mini-highlight"><span className="mini-label">Retained</span><strong>{item.retained_clients}</strong></div>
              </div>
              <p>New clients: <strong>{item.new_clients}</strong></p>
              <p>Lost clients: <strong>{item.lost_clients}</strong></p>
              <p>Top product: <strong>{item.top_product}</strong></p>
              <p>Recovery opportunity: <strong>{formatNumber(item.recovery_opportunity)}</strong></p>
            </article>
          ))}
        </div>
      </div>

      <div className="detail-grid">
        <div className="card">
          <div className="section-head">
            <div>
              <h2>Sales Team Snapshot</h2>
              <p className="section-subtext">Compact comparison block</p>
            </div>
          </div>
          <div className="stack-grid">
            {filteredTeam.map((member) => (
              <div className="mini-card" key={member.name}>
                <div className="row-between">
                  <strong>{member.name}</strong>
                  <span
                    className={
                      member.last_year === 0 && member.this_year > 0
                        ? "neutral"
                        : member.change_percent < 0
                        ? "negative"
                        : "positive"
                    }
                  >
                    {formatMeaningfulGrowth(member.last_year, member.this_year, member.change_percent)}
                  </span>
                </div>
                <p>{previousYearLabel}: {formatNumber(member.last_year)}</p>
                <p>{currentYearLabel}: {formatNumber(member.this_year)}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h2>Management Notes</h2>
              <p className="section-subtext">Quick commentary for fast review</p>
            </div>
          </div>
          <div className="stack-grid">
            <div className="mini-card">
              <strong>Top Sales Person</strong>
              <p>{s.top_sales_person}</p>
            </div>
            <div className="mini-card">
              <strong>Weakest Sales Person</strong>
              <p>{s.weakest_sales_person}</p>
            </div>
            <div className="mini-card">
              <strong>Lost vs New Gap</strong>
              <p>{s.lost_vs_new_gap || 0}</p>
            </div>
          </div>
        </div>
      </div>

      <SalesAiInsightsPanel
        apiBaseUrl={API_BASE_URL}
        salespersonNames={data.sales_scorecards
          .map((item) => item.name)
          .filter((name) => name && name.toLowerCase() !== "nan")}
        selectedSalesPerson={selectedSalesPerson}
        dataSource={dataSource}
        selectedTeam={selectedTeam}
      />
    </>
  );

  const renderRecoveryTab = () => (
    <>
      <div className="card">
        <div className="section-head">
          <div>
            <h2>Lost Client Recovery Panel</h2>
            <p className="section-subtext">Direct action list: kin clients ko turant call karna chahiye</p>
          </div>
          <span className="soft-counter">{data.lost_client_recovery.length} total</span>
        </div>
        <div className="product-grid">
          {pagedRecovery.items.map((item) => (
            <div className="mini-card" key={item.client_name}>
              <div className="row-between">
                <strong>{item.client_name}</strong>
                <span className={getBadgeClass(item.recovery_priority)}>{item.recovery_priority}</span>
              </div>
              <p>Last active qty: {formatNumber(item.last_year_quantity)}</p>
              <p>Product: {item.dominant_product}</p>
              <p>Sales person: {item.assigned_sales_person}</p>
              <p>Recovery score: {formatNumber(item.priority_score)}</p>
            </div>
          ))}
        </div>
        {renderPagination(pagedRecovery.page, pagedRecovery.pageCount, (next) =>
          setPagination((prev) => ({ ...prev, recoveryPage: next }))
        )}
      </div>

      <div className="dual-panel">
        <div className="card">
          <div className="section-head">
            <div>
              <h2>Recovery Notes</h2>
              <p className="section-subtext">Why this panel is high value</p>
            </div>
          </div>
          <div className="stack-grid">
            <div className="mini-card"><strong>Actionable</strong><p>Lost clients become direct call list instead of static reporting.</p></div>
            <div className="mini-card"><strong>Prioritized</strong><p>High-quantity and concentrated accounts show first.</p></div>
            <div className="mini-card"><strong>Owned</strong><p>Assigned sales person is visible for fast follow-up.</p></div>
          </div>
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h2>Recovery Pool Size</h2>
              <p className="section-subtext">Total lost-client opportunity</p>
            </div>
          </div>
          <div className="hero-stat">
            <h3>{data.lost_client_recovery.length}</h3>
            <p>total recovery candidates</p>
          </div>
          {data.lost_client_recovery.length > PAGE_SIZE && (
            <div className="info-banner">
              <CircleAlert size={15} />
              Recovery list paginated for smoother experience.
            </div>
          )}
        </div>
      </div>
    </>
  );

  const renderExecutiveTab = () => (
    <>
      <div className="dual-panel">
        <div className="card">
          <div className="section-head">
            <div>
              <h2>Executive Summary</h2>
              <p className="section-subtext">Meeting-ready recap</p>
            </div>
          </div>
          <div className="stack-grid">
            <div className="mini-card"><strong>Headline</strong><p>{data.executive_summary.headline}</p></div>
            <div className="mini-card">
              <strong>Highlights</strong>
              <ul className="bullet-list">
                {data.executive_summary.highlights.map((item, idx) => <li key={`h-${idx}`}>{item}</li>)}
              </ul>
            </div>
            <div className="mini-card">
              <strong>Risks</strong>
              <ul className="bullet-list">
                {data.executive_summary.risks.map((item, idx) => <li key={`r-${idx}`}>{item}</li>)}
              </ul>
            </div>
            <div className="mini-card">
              <strong>Opportunities</strong>
              <ul className="bullet-list">
                {data.executive_summary.opportunities.map((item, idx) => <li key={`o-${idx}`}>{item}</li>)}
              </ul>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h2>Target vs Actual</h2>
              <p className="section-subtext">Future-ready planning block</p>
            </div>
          </div>
          <div className="mini-highlight-grid">
            <div className="mini-highlight"><span className="mini-label">Target</span><strong>{formatNumber(data.target_summary.target_bags)}</strong></div>
            <div className="mini-highlight"><span className="mini-label">Actual</span><strong>{formatNumber(data.target_summary.actual_bags)}</strong></div>
            <div className="mini-highlight"><span className="mini-label">Achievement</span><strong>{formatPercent(data.target_summary.achievement_percent)}</strong></div>
            <div className="mini-highlight"><span className="mini-label">Gap</span><strong>{formatNumber(data.target_summary.gap)}</strong></div>
          </div>
          <div className="hero-stat compact">
            <h3>{formatNumber(data.target_summary.required_run_rate)}</h3>
            <p>required bags per month to close gap</p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h2>Operational Metadata</h2>
            <p className="section-subtext">Helpful for debugging and trust</p>
          </div>
        </div>
        <div className="detail-grid">
          <div className="mini-card"><strong>Source File</strong><p>{data.metadata?.source_file || "N/A"}</p></div>
          <div className="mini-card"><strong>Processed At</strong><p>{data.metadata?.last_processed_at || "N/A"}</p></div>
          <div className="mini-card"><strong>Cache Used</strong><p>{String(data.metadata?.cache_used ?? false)}</p></div>
        </div>
      </div>
    </>
  );

  return (
    <div className="page v2-shell">
      <div className="dashboard-bg-orb dashboard-bg-orb-1" />
      <div className="dashboard-bg-orb dashboard-bg-orb-2" />
      <div className="dashboard-grid-overlay" />

      <Sidebar
        groups={visibleGroups.map((g) => ({ key: g.key, label: g.label, items: g.items }))}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as TabKey)}
        username={authUser.username}
        roleLabel={ROLE_LABELS[userRole] || userRole}
        theme={theme}
        onToggleTheme={toggleTheme}
        accent={accent}
        onAccent={setAccent}
        onLogout={handleLogout}
      />

      <div className="container">
        <div className="hero-card">
          <div className="header">
            <div>
              <div className="logo-top-wrap">
                <img src="/logo.png" alt="Company Logo" className="company-logo-top" />
              </div>
              <p className="eyebrow">RPL Sales · Version {APP_VERSION}</p>
              <h1>{activeTabLabel}</h1>
              <p className="subtext">
                Sales Command Center — city, branch, team aur salesperson performance ek hi workspace mein.
              </p>
            </div>
            <div className="header-actions v2-header-actions">
              {(isAdmin || userRole === "dashboard_admin") && (
                <button className="action-btn primary-btn" onClick={() => setImportOpen(true)}>
                  <Upload size={16} /> Import Excel
                </button>
              )}
              {canViewDashboards && FILTER_TABS.includes(activeTab) && (
                <button className="action-btn" onClick={loadDashboard} disabled={loading}>
                  <RefreshCw size={16} className={loading ? "v2-spin" : undefined} /> Refresh
                </button>
              )}
              <ActionMenu
                items={[
                  ...(canViewDashboards
                    ? [{ key: "pdf", label: "Executive PDF", hint: "Print / save as PDF", icon: <Download size={15} />, onClick: exportPdf }]
                    : []),
                  ...(isAdmin
                    ? [
                        {
                          key: "backup",
                          label: "Download Backup",
                          hint: "Saara data Excel mein",
                          icon: <Download size={15} />,
                          onClick: async () => {
                            try {
                              const response = await fetch(`${API_BASE_URL}/admin/download-backup`);
                              if (!response.ok) throw new Error("Download failed");
                              const blob = await response.blob();
                              const url = window.URL.createObjectURL(blob);
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = `sales_backup_${new Date().toISOString().slice(0, 10)}.xlsx`;
                              document.body.appendChild(a);
                              a.click();
                              a.remove();
                              window.URL.revokeObjectURL(url);
                            } catch (err: any) {
                              alert(err.message || "Backup download failed");
                            }
                          },
                        },
                      ]
                    : []),
                  ...(isAdmin || userRole === "dashboard_admin" || userRole === "super_user"
                    ? [{ key: "entry", label: "Data Entry Form", hint: "Ek ek sale haath se", icon: <ClipboardList size={15} />, onClick: () => setActiveTab("dataEntry") }]
                    : []),
                ]}
              />
            </div>
          </div>


          <div className="hero-row">
            {canViewDashboards && FILTER_TABS.includes(activeTab) && (
            <div className="hero-strip">
              <div className={`hero-pill ${s.growth < 0 ? "tone-negative" : "tone-positive"}`}>
                {s.growth < 0 ? <TrendingDown size={16} /> : <TrendingUp size={16} />}
                <span>
                  {formatMeaningfulGrowth(s.last_year_sales, s.this_year_sales, s.growth)} overall performance
                </span>
              </div>

              <div className="hero-pill tone-neutral">
                <CalendarRange size={16} />
                <span>{data.available_months.join(", ") || "No active months"}</span>
              </div>

              <div className="hero-pill tone-neutral">
                <Package size={16} />
                <span>
                  {scopedTopProduct && scopedTopProduct.toLowerCase() !== "nan" ? scopedTopProduct : "N/A"} leads current mix
                </span>
              </div>

              <div className="hero-pill tone-neutral">
                <Sparkles size={16} />
                <span>{lastRefreshLabel ? `Last refresh: ${lastRefreshLabel}` : "Not refreshed yet"}</span>
              </div>
            </div>
            )}

          </div>
        </div>
       
        <div className="dashboard-body" style={{ gridTemplateColumns: showFilterRail ? undefined : "1fr" }}>
          <div className="left-rail" style={{ display: showFilterRail ? undefined : "none" }}>
            <div className="card filter-shell">
          <div className="section-head">
            <div>
              <h2>Filters</h2>
              <p className="section-subtext">Sales screens par lagu hote hain</p>
            </div>
            <div className="v2-rail-actions">
              <button className="ghost-btn" onClick={clearAllFilters} title="Reset filters">
                <X size={14} /> Reset
              </button>
              <button className="ghost-btn" onClick={() => setFiltersCollapsed(true)} title="Hide filters" aria-label="Hide filters">
                <SlidersHorizontal size={14} />
              </button>
            </div>
          </div>
          

          <div className="filter-grid">
            <div className="filter-block">
              <label><Filter size={14} /> Sales Person</label>
              <select
                value={selectedSalesPerson}
                onChange={(e) => setSelectedSalesPerson(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Sales Persons</option>
                {data.team
                  .filter((member) => member.name && member.name.toLowerCase() !== "nan")
                  .map((member) => (
                    <option key={member.name} value={member.name}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </div>

            <div className="filter-block">
              <label><CalendarRange size={14} /> View Mode</label>
              <select
                className="filter-select"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as any)}
              >
                <option value="compare">Compare (same selected months)</option>
                <option value="current_year">{currentYearLabel} - selected / all months total</option>
                <option value="previous_year">{previousYearLabel} - selected / all months total</option>
                <option value="current_month" disabled={selectedMonth === "all"}>
                  {currentYearLabel} - single month
                </option>
                <option value="previous_month" disabled={selectedMonth === "all"}>
                  {previousYearLabel} - single month
                </option>
              </select>
            </div>

            <div className="filter-block">
              <label><CalendarRange size={14} /> Year Scope</label>
              <select
                className="filter-select"
                value={yearScope}
                onChange={(e) => setYearScope(e.target.value as "ytd" | "full")}
                disabled={viewMode === "compare" || viewMode === "current_month" || viewMode === "previous_month"}
              >
                <option value="ytd">YTD / Same Months</option>
                <option value="full">Full Year</option>
              </select>
            </div>

            <div className="filter-block">
              <label><Users size={14} /> Client Status</label>
              <select
                value={clientStatusFilter}
                onChange={(e) => setClientStatusFilter(e.target.value as "all" | ClientStatus)}
                className="filter-select"
              >
                <option value="all">All Clients</option>
                <option value="new">New</option>
                <option value="lost">Lost</option>
                <option value="retained">Retained</option>
              </select>
            </div>

            <div className="filter-block">
              <label><CalendarRange size={14} /> Month</label>
              <select
                value={selectedMonth}
                onChange={(e) => {
                  setSelectedMonth(e.target.value);
                }}
                className="filter-select"
              >
                <option value="all">All Months</option>
                {getMonthOptions().map((month) => (
                  <option key={month} value={month}>
                    {month}
                  </option>
                ))}
              </select>
            </div>

            <div className="filter-block">
              <label><BarChart3 size={14} /> Top N</label>
              <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="filter-select">
                {[5, 6, 8, 10, 12].map((n) => (
                  <option key={n} value={n}>Top {n}</option>
                ))}
              </select>
            </div>

            {dataSource === "database" && orgCities.length > 0 && (
              <>
                <div className="filter-block">
                  <label><MapPin size={14} /> City</label>
                  <select
                    value={selectedCityId}
                    onChange={(e) => {
                      setSelectedCityId(e.target.value);
                      setSelectedBranchId("all");
                    }}
                    className="filter-select"
                  >
                    <option value="all">All Cities</option>
                    {orgCities.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="filter-block">
                  <label><Building2 size={14} /> Branch</label>
                  <select
                    value={selectedBranchId}
                    onChange={(e) => setSelectedBranchId(e.target.value)}
                    className="filter-select"
                  >
                    <option value="all">All Branches</option>
                    {branchOptions.map((b) => (
                      <option key={b.id} value={b.id}>
                        {selectedCityId === "all" ? `${b.cityName} / ${b.name}` : b.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {dataSource === "database" && (
              <div className="filter-block">
                <label><Users size={14} /> Team</label>
                <select
                  value={selectedTeam}
                  onChange={(e) => setSelectedTeam(e.target.value)}
                  className="filter-select"
                >
                  <option value="">{orgFilterActive ? `All teams here (${visibleTeams.length})` : "All teams"}</option>
                  {visibleTeams.map((team) => (
                    <option key={team.id} value={team.name}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="filter-block">
              <label><Package size={14} /> Unit</label>
              <select
                value={displayUnit}
                onChange={(e) => setDisplayUnit(e.target.value as "bag" | "kg")}
                className="filter-select"
              >
                <option value="bag">Bags</option>
                <option value="kg">KG</option>
              </select>
            </div>

            <div className="filter-block">
              <label><Search size={14} /> Client Search</label>
              <div className="search-box">
                <Search size={15} />
                <input
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Search client..."
                />
                {clientSearch ? (
                  <button className="search-clear" onClick={() => setClientSearch("")}>
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="filter-block filter-block-wide">
              <label><Package size={14} /> Product</label>
              <div className="product-dropdown" ref={productDropdownRef}>
                <button
                  type="button"
                  className="filter-select product-dropdown-trigger"
                  onClick={() => {
                    if (productDropdownRef.current) {
                      const rect = productDropdownRef.current.getBoundingClientRect();
                      const spaceBelow = window.innerHeight - rect.bottom;
                      const spaceAbove = rect.top;

                      const estimatedMenuHeight = 320;

                      if (spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow) {
                        setProductDropdownDirection("up");
                      } else {
                        setProductDropdownDirection("down");
                      }
                    }

                    setProductDropdownOpen((prev) => !prev);
                  }}
                >
                  <span>{productSelectionLabel}</span>
                  <ChevronDown size={16} />
                </button>

                {productDropdownOpen && (
                  <div className={`product-dropdown-menu ${productDropdownDirection === "up" ? "drop-up" : "drop-down"}`}>
                    <div className="product-dropdown-search">
                      <Search size={14} />
                      <input
                        type="text"
                        value={productSearch}
                        onChange={(e) => setProductSearch(e.target.value)}
                        placeholder="Search product..."
                        className="product-search-input"
                      />
                    </div>

                    <label className="dropdown-check-row dropdown-check-row-all">
                      <input type="checkbox" checked={allProductsSelected} onChange={toggleAllProducts} />
                      <span>Select All</span>
                    </label>

                    <div className="product-dropdown-list">
                      {searchedProductOptions.length === 0 ? (
                        <div className="product-dropdown-empty">No matching products</div>
                      ) : (
                        searchedProductOptions.map((productName) => (
                          <label key={productName} className="dropdown-check-row">
                            <input
                              type="checkbox"
                              checked={selectedProducts.includes(productName)}
                              onChange={() => toggleProductSelection(productName)}
                            />
                            <span>{productName}</span>
                          </label>
                        ))
                      )}
                    </div>                    
                  </div>
                )}
              </div>
            </div>
          </div>

          {activeFilterChips.length > 0 && (
            <div className="filter-chip-row">
              {activeFilterChips.map((chip) => (
                <button key={chip.key} className="filter-chip" onClick={chip.onClear}>
                  <span>{chip.label}</span>
                  <X size={13} />
                </button>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="status loading">Loading dashboard...</div>
        ) : error ? (
          <div className="status error">
            <AlertCircle size={16} />
            {error}
          </div>
        ) : (
          <div className="status success">Dashboard loaded successfully.</div>
        )}

        
        </div>

        <div className="right-panel" style={{ width: showFilterRail ? undefined : "100%" }}>
          {canViewDashboards && FILTER_TABS.includes(activeTab) && filtersCollapsed && (
            <div className="v2-filterbar">
              <button className="action-btn" onClick={() => setFiltersCollapsed(false)}>
                <SlidersHorizontal size={15} /> Filters
                {activeFilterChips.length > 0 && <span className="v2-badge">{activeFilterChips.length}</span>}
              </button>
              <span className="v2-filterbar-scope">{scopeLabel}</span>
              {activeFilterChips.map((chip) => (
                <button key={chip.key} className="filter-chip" onClick={chip.onClear}>
                  <span>{chip.label}</span>
                  <X size={13} />
                </button>
              ))}
              {loading && <span className="org-muted">Loading…</span>}
              {!loading && error && <span className="v2-filterbar-error">{error}</span>}
            </div>
          )}
          <Suspense fallback={<TabFallback />}>
          <div className="tab-content v2-page-enter" key={activeTab}>
            {activeTab === "overview" && renderOverviewTab()}
            {activeTab === "clients" && renderClientsTab()}
            {activeTab === "products" && renderProductsTab()}
            {activeTab === "team" && renderTeamTab()}
            {activeTab === "recovery" && renderRecoveryTab()}
            {activeTab === "executive" && renderExecutiveTab()}
            {activeTab === "visit" && <VisitForm />}
            {activeTab === "dataEntry" && <DataEntry />}
            {activeTab === "forecast" && <ForecastTab />}
            {activeTab === "productContribution" && <ProductContributionTab />}
            {activeTab === "admin" && isAdmin && (
              <>
                <AdminPanel />
                <DangerZone />
              </>
            )}
            {activeTab === "organization" && isAdmin && <OrgAdmin />}
            {activeTab === "multiYear" && canViewDashboards && (
              orgFilterActive && !selectedTeam && visibleTeams.length === 0 ? (
                <div className="card"><p className="org-muted">Is city/branch mein abhi koi team map nahi hui.</p></div>
              ) : (
                <MultiYear
                  teams={selectedTeam ? [selectedTeam] : orgFilterActive ? visibleTeams.map((t) => t.name) : []}
                  teamLabel={selectedTeam ? selectedTeam : orgFilterActive ? `${visibleTeams.length} teams (filtered)` : "All teams in your scope"}
                  salesPerson={selectedSalesPerson}
                  chart={chart}
                  tooltipProps={tooltipProps}
                  axisProps={axisProps}
                />
              )
            )}
            {activeTab === "home" && (
              <HomePage
                canViewDashboards={canViewDashboards}
                onNavigate={(tab) => setActiveTab(tab)}
                onOpenCustomer={(name) => {
                  setCustomerFocus(name);
                  setActiveTab("customers");
                }}
              />
            )}
            {activeTab === "planner" && (
              <VisitPlanner
                canFilterPeople={userRole !== "user"}
                onLogVisit={() => setActiveTab("visit")}
                onOpenCustomer={(name) => {
                  setCustomerFocus(name);
                  setActiveTab("customers");
                }}
              />
            )}
            {activeTab === "customers" && (
              <Customer360 initialName={customerFocus} chart={chart} tooltipProps={tooltipProps} axisProps={axisProps} />
            )}
          </div>
          </Suspense>
        </div>
      </div>

        {importOpen && (
          <Suspense fallback={null}>
            <ImportDialog
              teams={masterTeams.map((t) => t.name)}
              defaultTeam={selectedTeam}
              onClose={() => setImportOpen(false)}
              onDone={() => {
                loadMasterTeams();
                loadDashboard();
              }}
            />
          </Suspense>
        )}

        {(isAdmin || isSuperUser) && (
          <Suspense fallback={null}>
            <RessiBot apiBaseUrl={API_BASE_URL} />
          </Suspense>
        )}

        <div className="footer">
          © {new Date().getFullYear()} Created by Adil Siddiqui — Ressichem Pvt Ltd · RPL Sales v{APP_VERSION}
        </div>
      </div>
    </div>
  );
}

export default App;
