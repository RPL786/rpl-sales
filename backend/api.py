from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.request
import psycopg2
from datetime import datetime
from typing import Any, Dict, List, Optional
import sys
import socket
import webbrowser
import uvicorn
from psycopg2.extras import execute_values

import pandas as pd
from sales_auditor import get_boss_audit
from fastapi import FastAPI, File, HTTPException, UploadFile, Header, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
class AISettingsUpdate(BaseModel):
    provider: str
    model: str
    fallback_model: str | None = None
    api_key: str
    timeout_seconds: int
    enabled: bool
from typing import Any, Dict, List
import json
from fastapi.responses import JSONResponse
import time
import gc

from auth_utils import hash_password, verify_password, create_access_token

try:
    from dotenv import load_dotenv
    from dotenv import load_dotenv
    from pathlib import Path

    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(dotenv_path=env_path, override=True)
except ImportError:
    pass

app = FastAPI(title="Sales Intelligence API", version="5.1.0")

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS"))
    PROJECT_ROOT = APP_DIR
else:
    APP_DIR = Path(__file__).resolve().parent
    BUNDLE_DIR = APP_DIR
    PROJECT_ROOT = APP_DIR.parent

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
PUBLIC_DIR = PROJECT_ROOT / "frontend" / "public"

app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

@app.get("/logo.png", include_in_schema=False)
async def serve_logo():
    dist_logo = FRONTEND_DIST / "logo.png"
    public_logo = PUBLIC_DIR / "logo.png"

    if dist_logo.exists():
        return FileResponse(dist_logo)

    if public_logo.exists():
        return FileResponse(public_logo)

    raise HTTPException(status_code=404, detail="logo.png not found")

@app.get("/")
async def serve_frontend():
    return FileResponse(FRONTEND_DIST / "index.html")

frontend_origins_raw = os.getenv("FRONTEND_ORIGINS", "*")
FRONTEND_ORIGINS = [x.strip() for x in frontend_origins_raw.split(",") if x.strip()] or ["*"]

allow_all_origins = FRONTEND_ORIGINS == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[] if allow_all_origins else FRONTEND_ORIGINS,
    allow_origin_regex=".*" if allow_all_origins else None,
    allow_credentials=False if allow_all_origins else True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = APP_DIR / "data"
VISITS_FILE_PATH = DATA_DIR / "visit_logs.json"
UPLOAD_FILE_PATH = DATA_DIR / "uploaded_sales.xlsx"
CACHE_FILE_PATH = DATA_DIR / "dashboard_cache.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_FILE_PATH = DATA_DIR / "sales_dashboard.db"
print("USING DB FILE:", DB_FILE_PATH)
DATA_ENTRY_HTML_PATH = BUNDLE_DIR / "data_entry.html"
ADMIN_CLEAR_PASSWORD = "chai123"


def get_db_connection():
    try:
        conn = psycopg2.connect(
            host=os.getenv("POSTGRES_HOST"),
            port=os.getenv("POSTGRES_PORT"),
            database=os.getenv("POSTGRES_DB"),
            user=os.getenv("POSTGRES_USER"),
            password=os.getenv("POSTGRES_PASSWORD"),
        )

        print("CONNECTED TO POSTGRES:", os.getenv("POSTGRES_DB"))
        return conn

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"PostgreSQL connection failed: {str(e)}"
        )
    
def get_ai_settings():
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT provider,
               model,
               fallback_model,
               api_key,
               timeout_seconds,
               enabled
        FROM ai_settings
        ORDER BY id DESC
        LIMIT 1
    """)

    row = cur.fetchone()

    cur.close()
    conn.close()

    if not row:
        return None

    return {
        "provider": row[0],
        "model": row[1],
        "fallback_model": row[2],
        "api_key": row[3],
        "timeout_seconds": row[4],
        "enabled": row[5],
    }


def ensure_lookup_value(conn, table_name: str, value: str):
    value = (value or "").strip()
    if not value:
        return

    cur = conn.cursor()
    cur.execute(
        f"INSERT INTO {table_name} (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
        (value,)
    )
    conn.commit()


def fetch_lookup_values(conn, table_name: str):
    cur = conn.cursor()
    cur.execute(f"SELECT name FROM {table_name} ORDER BY name")
    return [
        row[0]
        for row in cur.fetchall()
        if row[0] and str(row[0]).strip().lower() not in {"nan", "none"}
    ]


def month_from_date(date_str: str):
    dt = datetime.fromisoformat(date_str)
    return dt.strftime("%b")

MONTH_TO_NUM = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4,
    "May": 5, "Jun": 6, "Jul": 7, "Aug": 8,
    "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}


def make_month_date(year_value: int, month_name: str) -> str:
    month_name = str(month_name).strip()[:3].title()
    month_num = MONTH_TO_NUM.get(month_name)
    if not month_num:
        raise ValueError(f"Invalid month name: {month_name}")
    return f"{int(year_value):04d}-{month_num:02d}-01"

def year_from_date(date_str: str):
    dt = datetime.fromisoformat(date_str)
    return dt.year

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

def get_available_months_for_df(df: pd.DataFrame) -> List[str]:
    monthly = df[MONTHS].sum()
    return [month for month in MONTHS if safe_float(monthly.get(month, 0)) > 0]

DASHBOARD_CACHE: Optional[Dict[str, Any]] = None
AI_SETTINGS = get_ai_settings()

GEMINI_API_KEY = AI_SETTINGS["api_key"] if AI_SETTINGS else None
GEMINI_MODEL = AI_SETTINGS["model"] if AI_SETTINGS else "gemini-1.5-flash"
GEMINI_TIMEOUT_SECONDS = AI_SETTINGS["timeout_seconds"] if AI_SETTINGS else 180

print("DB MODEL:", GEMINI_MODEL, flush=True)

if GEMINI_API_KEY:
    print("DB GEMINI KEY LAST 6:", GEMINI_API_KEY[-6:], flush=True)
else:
    print("NO DB GEMINI API KEY FOUND", flush=True)

AI_INSIGHTS_ENABLED = AI_SETTINGS["enabled"] if AI_SETTINGS else False


class SalespersonInsightsRequest(BaseModel):
    salesperson_names: List[str] = Field(default_factory=list)
    data_source: str = "excel"
    team: str = ""

class VisitEntryRequest(BaseModel):
    team: str
    sales_person: str
    client_name: str
    client_category: str = ""
    product: str
    meeting_date: str
    meeting_time: str
    meeting_type: str
    meeting_status: str
    client_response: str = ""
    order_amount: float = 0.0
    quantity: float = 0.0
    future_potential: float = 0.0
    next_meeting_date: str = ""
    next_meeting_time: str = ""
    notes: str = ""

class VisitBulkRequest(BaseModel):
    visits: List[VisitEntryRequest]

def safe_int(value: Any) -> int:
    if pd.isna(value):
        return 0
    return int(round(float(value)))


def safe_float(value: Any) -> float:
    if pd.isna(value):
        return 0.0
    return float(value)


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def load_visit_logs() -> List[Dict[str, Any]]:
    if not VISITS_FILE_PATH.exists():
        return []
    try:
        data = json.loads(VISITS_FILE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_visit_logs(rows: List[Dict[str, Any]]) -> None:
    VISITS_FILE_PATH.write_text(
        json.dumps(rows, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def parse_year_sheet_name(sheet_name: str) -> Optional[int]:
    name = str(sheet_name).strip()
    if len(name) == 4 and name.isdigit():
        return int(name)
    return None


def standardize_sheet(df: pd.DataFrame, year: int) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(col).strip() for col in df.columns]

    rename_map = {
        "Grand Total": "Total",
        "Client": "Client Name",
        "ClientName": "Client Name",
        "Salesperson": "Sales Person",
        "Sales Person Name": "Sales Person",
        "Item": "Product",
    }
    df = df.rename(columns=rename_map)

    required = ["Sales Person", "Client Name", "Product"]
    for col in required:
        if col not in df.columns:
            raise HTTPException(status_code=400, detail=f"Missing column '{col}' in sheet {year}")

    if "Total" not in df.columns:
        df["Total"] = 0

    for month in MONTHS:
        if month not in df.columns:
            df[month] = 0

    text_cols = ["Sales Person", "Client Name", "Product"]
    for col in text_cols:
        df[col] = (
            df[col]
            .fillna("")
            .astype(str)
            .str.strip()
            .replace({"nan": "", "NaN": "", "None": ""})
        )

    numeric_cols = MONTHS + ["Total"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    df = df[(df["Sales Person"] != "") | (df["Client Name"] != "") | (df["Product"] != "")]
    df["Year"] = year
    return df

def get_salesperson_visit_summary(name: str):
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            client_name,
            COUNT(*) as visits,
            SUM(order_amount) as total_order,
            AVG(future_potential) as avg_potential,
            STRING_AGG(client_response, ' | ') as responses
        FROM visit_entries
        WHERE sales_person = %s
        GROUP BY client_name
    """, (name,))

    rows = cur.fetchall()
    conn.close()

    summary = []

    for r in rows:
        summary.append({
            "client": r[0],
            "visits": r[1] or 0,
            "total_order": r[2] or 0,
            "avg_potential": r[3] or 0,
            "responses": r[4] or ""
        })

    return summary


def get_year_sheets():
    if not UPLOAD_FILE_PATH.exists():
        raise HTTPException(status_code=404, detail="Upload file first")

    try:
        with pd.ExcelFile(UPLOAD_FILE_PATH, engine="openpyxl") as workbook:
            year_sheets: Dict[int, str] = {}
            for sheet_name in workbook.sheet_names:
                year = parse_year_sheet_name(sheet_name)
                if year is not None:
                    year_sheets[year] = sheet_name
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read workbook: {str(exc)}") from exc

    if len(year_sheets) < 2:
        raise HTTPException(
            status_code=400,
            detail="Workbook must contain at least 2 year sheets like previous, current",
        )

    sorted_years = sorted(year_sheets.keys())
    previous_year = sorted_years[-2]
    current_year = sorted_years[-1]
    return year_sheets, previous_year, current_year


def load_workbook_data():
    year_sheets, previous_year, current_year = get_year_sheets()

    try:
        df_previous = pd.read_excel(
            UPLOAD_FILE_PATH,
            sheet_name=year_sheets[previous_year],
            engine="openpyxl",
        )
        df_current = pd.read_excel(
            UPLOAD_FILE_PATH,
            sheet_name=year_sheets[current_year],
            engine="openpyxl",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to load year sheets: {str(exc)}") from exc

    return (
        standardize_sheet(df_previous, previous_year),
        standardize_sheet(df_current, current_year),
        previous_year,
        current_year,
    )


def load_database_data(team: str):
    conn = get_db_connection()

    try:
        df_raw = pd.read_sql_query("""
            SELECT sales_person, client_name, client_category, product, entry_date, quantity
            FROM sales_entries
            WHERE team = %s
        """, conn, params=(team,))
    except Exception as exc:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Failed to read database data: {str(exc)}") from exc

    conn.close()

    if df_raw.empty:
        raise HTTPException(status_code=404, detail=f"No data found for team '{team}'")

    try:
        df_raw["entry_date"] = pd.to_datetime(df_raw["entry_date"], errors="coerce")
        df_raw = df_raw.dropna(subset=["entry_date"])
        df_raw["Year"] = df_raw["entry_date"].dt.year
        df_raw["month"] = df_raw["entry_date"].dt.strftime("%b")
        df_raw["quantity"] = pd.to_numeric(df_raw["quantity"], errors="coerce").fillna(0)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to process database data: {str(exc)}") from exc

    pivot = (
        df_raw.pivot_table(
            index=["sales_person", "client_name", "product", "Year"],
            columns="month",
            values="quantity",
            aggfunc="sum",
            fill_value=0,
        )
        .reset_index()
    )

    pivot.columns.name = None

    pivot = pivot.rename(columns={
        "sales_person": "Sales Person",
        "client_name": "Client Name",
        "product": "Product",
    })

    for m in MONTHS:
        if m not in pivot.columns:
            pivot[m] = 0

    pivot["Total"] = pivot[MONTHS].sum(axis=1)

    years = sorted(pivot["Year"].dropna().unique().tolist())
    if len(years) < 2:
        raise HTTPException(
            status_code=400,
            detail="Database must contain at least 2 years of data for comparison",
        )

    previous_year = years[-2]
    current_year = years[-1]

    df_previous = pivot[pivot["Year"] == previous_year].copy()
    df_current = pivot[pivot["Year"] == current_year].copy()

    return (
        standardize_sheet(df_previous, previous_year),
        standardize_sheet(df_current, current_year),
        previous_year,
        current_year,
    )

def ensure_database_schema():
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        target_type TEXT DEFAULT 'QTY'
    )
    """)

    cur.execute("""
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS target_type TEXT DEFAULT 'QTY'
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS sales_people (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        team TEXT,
        sales_target REAL DEFAULT 0,
        target_duration TEXT DEFAULT 'monthly'
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS sales_targets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        username TEXT NOT NULL,
        team TEXT NOT NULL,
        target_year INTEGER NOT NULL,
        target_month TEXT NOT NULL,
        target_kg REAL DEFAULT 0,
        target_type TEXT DEFAULT 'QTY',
        target_value REAL DEFAULT 0,
        UNIQUE(username, team, target_year, target_month)
    )
    """)

    cur.execute("""
    ALTER TABLE sales_targets
    ADD COLUMN IF NOT EXISTS target_type TEXT DEFAULT 'QTY'
    """)

    cur.execute("""
    ALTER TABLE sales_targets
    ADD COLUMN IF NOT EXISTS target_value REAL DEFAULT 0
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS sales_entries (
        id SERIAL PRIMARY KEY,
        team TEXT NOT NULL,
        sales_person TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_category TEXT,
        product TEXT NOT NULL,
        year INTEGER NOT NULL,
        month TEXT NOT NULL,
        quantity REAL NOT NULL,
        amount REAL DEFAULT 0,
        entry_date TEXT
    )
    """)

    cur.execute("""
    ALTER TABLE sales_entries
    ADD COLUMN IF NOT EXISTS amount REAL DEFAULT 0
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS ai_settings (
        id SERIAL PRIMARY KEY,
        provider TEXT DEFAULT 'gemini',
        model TEXT DEFAULT 'gemini-1.5-flash',
        fallback_model TEXT DEFAULT 'gemini-1.5-flash',
        api_key TEXT DEFAULT '',
        timeout_seconds INTEGER DEFAULT 180,
        enabled BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    cur.execute("""
    INSERT INTO ai_settings (
        provider, model, fallback_model, api_key, timeout_seconds, enabled
    )
    SELECT 'gemini', 'gemini-1.5-flash', 'gemini-1.5-flash', '', 180, false
    WHERE NOT EXISTS (SELECT 1 FROM ai_settings)
    """)
    
    cur.execute("""
    CREATE TABLE IF NOT EXISTS visit_entries (
        id SERIAL PRIMARY KEY,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        team TEXT NOT NULL,
        sales_person TEXT NOT NULL,
        client_name TEXT NOT NULL,
        client_category TEXT,
        product TEXT NOT NULL,
        meeting_date TEXT NOT NULL,
        meeting_time TEXT NOT NULL,
        meeting_type TEXT NOT NULL,
        meeting_status TEXT NOT NULL,
        client_response TEXT,
        order_amount REAL DEFAULT 0,
        quantity REAL DEFAULT 0,
        future_potential REAL DEFAULT 0,
        next_meeting_date TEXT,
        next_meeting_time TEXT,
        notes TEXT
    )
    """)

    admin_username = os.getenv("ADMIN_USERNAME", "admin").strip()
    admin_password = os.getenv("ADMIN_PASSWORD", "admin123").strip()

    cur.execute(
        "SELECT id FROM users WHERE username = %s",
        (admin_username,)
    )

    existing_admin = cur.fetchone()

    if not existing_admin:
        cur.execute("""
            INSERT INTO users (username, password, role, team)
            VALUES (%s, %s, %s, %s)
        """, (
            admin_username,
            hash_password(admin_password),
            "admin",
            ""
        ))

        print("DEFAULT ADMIN CREATED")

    conn.commit()
    conn.close()

@app.on_event("startup")
def startup_create_schema():
    print("RUNNING DB SCHEMA CHECK...")
    ensure_database_schema()
    

def load_database_data(team: str):
    try:
        conn = get_db_connection()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Database connection failed: {str(exc)}") from exc

    try:
        query = """
            SELECT
                team,
                sales_person,
                client_name,
                product,
                year,
                month,
                quantity
            FROM sales_entries
            WHERE team = %s
        """
        df_raw = pd.read_sql_query(query, conn, params=(team,))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read database data: {str(exc)}") from exc
    finally:
        conn.close()

    if df_raw.empty:
        raise HTTPException(status_code=404, detail=f"No data found for team '{team}'")

    required_cols = {"sales_person", "client_name", "product", "year", "month", "quantity"}
    if not required_cols.issubset(set(df_raw.columns)):
        raise HTTPException(status_code=400, detail="Database table structure is invalid")

    df_raw["month"] = df_raw["month"].astype(str).str.strip()
    df_raw["year"] = pd.to_numeric(df_raw["year"], errors="coerce")
    df_raw["quantity"] = pd.to_numeric(df_raw["quantity"], errors="coerce").fillna(0)

    df_raw = df_raw.dropna(subset=["year"])
    df_raw["year"] = df_raw["year"].astype(int)

    pivot = (
        df_raw.pivot_table(
            index=["sales_person", "client_name", "product", "year"],
            columns="month",
            values="quantity",
            aggfunc="sum",
            fill_value=0,
        )
        .reset_index()
    )

    pivot.columns.name = None

    rename_map = {
        "sales_person": "Sales Person",
        "client_name": "Client Name",
        "product": "Product",
        "year": "Year",
    }
    pivot = pivot.rename(columns=rename_map)

    for month in MONTHS:
        if month not in pivot.columns:
            pivot[month] = 0

    pivot["Total"] = pivot[MONTHS].sum(axis=1)

    years = sorted(pivot["Year"].dropna().unique().tolist())
    if len(years) < 2:
        raise HTTPException(
            status_code=400,
            detail="Database must contain at least 2 years of data for comparison",
        )

    previous_year = years[-2]
    current_year = years[-1]

    df_previous = pivot[pivot["Year"] == previous_year].copy()
    df_current = pivot[pivot["Year"] == current_year].copy()

    return (
        standardize_sheet(df_previous, previous_year),
        standardize_sheet(df_current, current_year),
        previous_year,
        current_year,
    )


def get_available_months(df_current: pd.DataFrame) -> List[str]:
    monthly_current = df_current[MONTHS].sum()
    return [month for month in MONTHS if safe_float(monthly_current.get(month, 0)) > 0]


def add_period_total(df: pd.DataFrame, months: List[str]) -> pd.DataFrame:
    df = df.copy()
    df["period_total"] = df[months].sum(axis=1) if months else 0
    return df


def classify_priority(rank: int, total_items: int) -> str:
    if total_items <= 3:
        return "high" if rank == 0 else "medium"
    if rank < max(1, math.ceil(total_items * 0.34)):
        return "high"
    if rank < max(2, math.ceil(total_items * 0.67)):
        return "medium"
    return "low"


def get_client_owner(rows: pd.DataFrame) -> str:
    grouped = rows[rows["Sales Person"] != ""].groupby("Sales Person")["period_total"].sum().sort_values(ascending=False)
    return grouped.index[0] if not grouped.empty else "N/A"


def get_top_product(rows: pd.DataFrame) -> str:
    grouped = rows[rows["Product"] != ""].groupby("Product")["period_total"].sum().sort_values(ascending=False)
    return grouped.index[0] if not grouped.empty else "N/A"


def build_monthly_series(
    prev_rows: pd.DataFrame,
    curr_rows: pd.DataFrame,
    months: List[str],
) -> List[Dict[str, int]]:
    return [
        {
            "month": month,
            "previous": safe_int(prev_rows[month].sum()) if month in prev_rows.columns else 0,
            "current": safe_int(curr_rows[month].sum()) if month in curr_rows.columns else 0,
        }
        for month in months
    ]


def with_metadata(payload: Dict[str, Any], source_file: str, cache_used: bool = False) -> Dict[str, Any]:
    payload["metadata"] = {
        "source_file": source_file,
        "last_processed_at": now_iso(),
        "cache_used": cache_used,
        "ai_enabled": AI_INSIGHTS_ENABLED,
        "ai_provider": "gemini" if GEMINI_API_KEY and AI_INSIGHTS_ENABLED else "fallback",
    }
    return payload


def save_cache(payload: Dict[str, Any]) -> None:
    global DASHBOARD_CACHE
    DASHBOARD_CACHE = payload
    CACHE_FILE_PATH.write_text(json.dumps(payload), encoding="utf-8")


def load_cache_file() -> Optional[Dict[str, Any]]:
    if not CACHE_FILE_PATH.exists():
        return None
    try:
        return json.loads(CACHE_FILE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def build_dashboard_data(df_previous: pd.DataFrame, df_current: pd.DataFrame, previous_year: int, current_year: int) -> Dict[str, Any]:
    for df in [df_previous, df_current]:
        for col in ["Sales Person", "Client Name", "Product"]:
            if col in df.columns:
                df[col] = (
                    df[col]
                    .fillna("")
                    .astype(str)
                    .str.strip()
                    .replace({"nan": "", "NaN": "", "None": ""})
                )    
    same_period_months = get_available_months(df_current)
    previous_year_months = get_available_months_for_df(df_previous)
    current_year_months = get_available_months_for_df(df_current)

    full_year_months = MONTHS[:]

    df_previous = add_period_total(df_previous, same_period_months)
    df_current = add_period_total(df_current, same_period_months)

    monthly_previous = df_previous[MONTHS].sum()
    monthly_current = df_current[MONTHS].sum()

    same_period_previous_total = safe_float(monthly_previous[same_period_months].sum()) if same_period_months else 0
    current_ytd_total = safe_float(monthly_current[same_period_months].sum()) if same_period_months else 0
    growth = ((current_ytd_total - same_period_previous_total) / same_period_previous_total * 100) if same_period_previous_total else 0

    all_sales_people = sorted(person for person in set(df_previous["Sales Person"]).union(set(df_current["Sales Person"])) if person)
    team_data: List[Dict[str, Any]] = []
    sales_scorecards: List[Dict[str, Any]] = []
    salesperson_monthly_trend: List[Dict[str, Any]] = []
    weakest_person = "N/A"
    worst_change = None
    top_sales_person = "N/A"
    top_sales_value = -1.0

    for person in all_sales_people:
        person_previous = df_previous[df_previous["Sales Person"] == person]
        person_current = df_current[df_current["Sales Person"] == person]
        last_val = safe_float(person_previous["period_total"].sum())
        this_val = safe_float(person_current["period_total"].sum())
        if last_val == 0 and this_val == 0:
            continue

        change = ((this_val - last_val) / last_val * 100) if last_val else (100 if this_val > 0 else 0)
        baseline_status = classify_baseline_status(last_val, this_val)
        team_data.append({
            "name": person,
            "last_year": safe_int(last_val),
            "this_year": safe_int(this_val),
            "change_percent": round(change, 2),
            "baseline_status": baseline_status,
        })

        if this_val > top_sales_value:
            top_sales_value = this_val
            top_sales_person = person

        if worst_change is None or change < worst_change:
            worst_change = change
            weakest_person = person

        prev_client_totals = person_previous[person_previous["Client Name"] != ""].groupby("Client Name")["period_total"].sum().to_dict()
        curr_client_totals = person_current[person_current["Client Name"] != ""].groupby("Client Name")["period_total"].sum().to_dict()

        prev_clients = {name for name, total in prev_client_totals.items() if total > 0}
        curr_clients = {name for name, total in curr_client_totals.items() if total > 0}

        curr_product_mix = person_current[person_current["Product"] != ""].groupby("Product")["period_total"].sum().sort_values(ascending=False)
        prev_product_mix = person_previous[person_previous["Product"] != ""].groupby("Product")["period_total"].sum().sort_values(ascending=False)
        top_person_product = curr_product_mix.index[0] if not curr_product_mix.empty else (prev_product_mix.index[0] if not prev_product_mix.empty else "N/A")
        recovery_opportunity = safe_int(sum(prev_client_totals.get(client, 0) for client in (prev_clients - curr_clients)))

        sales_scorecards.append({
            "name": person,
            "last_year": safe_int(last_val),
            "this_year": safe_int(this_val),
            "change_percent": round(change, 2),
            "active_clients": len(curr_clients),
            "new_clients": len(curr_clients - prev_clients),
            "lost_clients": len(prev_clients - curr_clients),
            "retained_clients": len(prev_clients.intersection(curr_clients)),
            "top_product": top_person_product,
            "recovery_opportunity": recovery_opportunity,
            "baseline_status": baseline_status,
        })

        salesperson_monthly_trend.append({
            "name": person,
            "monthly_trend": [
                {
                    "month": month,
                    "previous": safe_int(person_previous[month].sum()) if month in person_previous.columns else 0,
                    "current": safe_int(person_current[month].sum()) if month in person_current.columns else 0,
                }
                for month in MONTHS
            ],
        })

    team_data.sort(key=lambda x: x["this_year"], reverse=True)
    sales_scorecards.sort(key=lambda x: x["this_year"], reverse=True)

    all_products = sorted(product for product in set(df_previous["Product"]).union(set(df_current["Product"])) if product)
    product_data: List[Dict[str, Any]] = []
    product_drilldown: List[Dict[str, Any]] = []
    top_product = "N/A"
    top_product_value = -1.0
    fastest_growing_product = "N/A"
    fastest_growth_value = -10**9
    declining_product = "N/A"
    declining_growth_value = 10**9

    for product in all_products:
        prev_rows = df_previous[df_previous["Product"] == product]
        curr_rows = df_current[df_current["Product"] == product]
        prev_total = safe_float(prev_rows["period_total"].sum())
        curr_total = safe_float(curr_rows["period_total"].sum())

        if curr_total > 0:
            share = (curr_total / current_ytd_total * 100) if current_ytd_total else 0
            product_data.append({
                "name": product,
                "sales": safe_int(curr_total),
                "share": round(share, 2),
            })
            if curr_total > top_product_value:
                top_product_value = curr_total
                top_product = product

        if prev_total == 0 and curr_total == 0:
            continue

        growth_percent = ((curr_total - prev_total) / prev_total * 100) if prev_total else (100 if curr_total > 0 else 0)
        if growth_percent > fastest_growth_value and curr_total > 0:
            fastest_growth_value = growth_percent
            fastest_growing_product = product
        if growth_percent < declining_growth_value and prev_total > 0:
            declining_growth_value = growth_percent
            declining_product = product

        sales_person_mix = curr_rows[curr_rows["Sales Person"] != ""].groupby("Sales Person")["period_total"].sum().sort_values(ascending=False)
        product_top_sales_person = sales_person_mix.index[0] if not sales_person_mix.empty else "N/A"

        client_count = int(curr_rows[curr_rows["period_total"] > 0]["Client Name"].replace("", pd.NA).dropna().nunique())
        product_drilldown.append({
            "name": product,
            "last_year_sales": safe_int(prev_total),
            "this_year_sales": safe_int(curr_total),
            "growth_percent": round(growth_percent, 2),
            "client_count": client_count,
            "top_sales_person": product_top_sales_person,
            "monthly_trend": build_monthly_series(prev_rows, curr_rows, full_year_months),
        })

    product_data.sort(key=lambda x: x["sales"], reverse=True)
    product_drilldown.sort(key=lambda x: x["this_year_sales"], reverse=True)
    product_concentration_risk = product_data[0]["share"] if product_data else 0

    client_totals_previous = df_previous[df_previous["Client Name"] != ""].groupby("Client Name")["period_total"].sum().to_dict()
    client_totals_current = df_current[df_current["Client Name"] != ""].groupby("Client Name")["period_total"].sum().to_dict()

    active_clients_previous = {name for name, total in client_totals_previous.items() if total > 0}
    active_clients_current = {name for name, total in client_totals_current.items() if total > 0}
    new_clients = active_clients_current - active_clients_previous
    lost_clients = active_clients_previous - active_clients_current
    retained_clients = active_clients_previous.intersection(active_clients_current)
    all_clients = sorted(active_clients_previous.union(active_clients_current))

    clients_data: List[Dict[str, Any]] = []
    client_drilldown: List[Dict[str, Any]] = []
    new_client_quality: List[Dict[str, Any]] = []

    for client in all_clients:
        prev_rows = df_previous[df_previous["Client Name"] == client]
        curr_rows = df_current[df_current["Client Name"] == client]
        prev_total = safe_float(client_totals_previous.get(client, 0))
        curr_total = safe_float(client_totals_current.get(client, 0))

        if client in new_clients:
            status = "new"
            quantity = curr_total
        elif client in lost_clients:
            status = "lost"
            quantity = prev_total
        else:
            status = "retained"
            quantity = curr_total

        clients_data.append({"name": client, "status": status, "quantity": safe_int(quantity)})

        if curr_total == 0 and prev_total == 0:
            continue

        owner_rows = curr_rows if curr_total > 0 else prev_rows
        assigned_sales_person = get_client_owner(owner_rows)
        dominant_product = get_top_product(owner_rows)
        client_drilldown.append({
            "name": client,
            "status": status,
            "current_year_quantity": safe_int(curr_total),
            "previous_year_quantity": safe_int(prev_total),
            "delta": safe_int(curr_total - prev_total),
            "dominant_product": dominant_product,
            "assigned_sales_person": assigned_sales_person,
            "monthly_trend": build_monthly_series(prev_rows, curr_rows, full_year_months),
        })

        if client in new_clients:
            active_months = [month for month in full_year_months if safe_float(curr_rows[month].sum()) > 0]
            first_active_month = active_months[0] if active_months else "N/A"
            product_mix = curr_rows[curr_rows["Product"] != ""].groupby("Product")["period_total"].sum().sort_values(ascending=False)
            product_mix_payload = [{"product": product_name, "quantity": safe_int(qty)} for product_name, qty in product_mix.head(3).items()]
            quality_label = "trial"
            if curr_total >= max(current_ytd_total * 0.02, 200):
                quality_label = "strong"
            elif curr_total >= max(current_ytd_total * 0.008, 75):
                quality_label = "developing"

            new_client_quality.append({
                "client_name": client,
                "first_active_month": first_active_month,
                "sales_person": assigned_sales_person,
                "quantity": safe_int(curr_total),
                "product_mix": product_mix_payload,
                "is_meaningful": quality_label != "trial",
                "quality_label": quality_label,
            })

    clients_data.sort(key=lambda x: ({'lost': 0, 'new': 1, 'retained': 2}[x['status']], -x['quantity'], x['name'].lower()))
    client_drilldown.sort(key=lambda x: ({'lost': 0, 'new': 1, 'retained': 2}[x['status']], -max(x['current_year_quantity'], x['previous_year_quantity'])))
    new_client_quality.sort(key=lambda x: x['quantity'], reverse=True)

    chart_data = [
        {
            "month": month,
            "previous": safe_int(monthly_previous.get(month, 0)),
            "current": safe_int(monthly_current.get(month, 0)),
            "previous_has_data": month in previous_year_months,
            "current_has_data": month in current_year_months,
        }
        for month in MONTHS
    ]

    month_comparison = []
    for month in MONTHS:
        prev_value = safe_float(monthly_previous.get(month, 0))
        curr_value = safe_float(monthly_current.get(month, 0))
        month_growth = ((curr_value - prev_value) / prev_value * 100) if prev_value else (100 if curr_value > 0 else 0)
        month_comparison.append({
            "month": month,
            "year_previous": safe_int(prev_value),
            "year_current": safe_int(curr_value),
            "previous": safe_int(prev_value),
            "current": safe_int(curr_value),
            "growth_percent": round(month_growth, 2),
            "delta": safe_int(curr_value - prev_value),
            "previous_has_data": month in previous_year_months,
            "current_has_data": month in current_year_months,
        })

    lost_client_recovery = []
    for client in sorted(lost_clients):
        prev_rows = df_previous[(df_previous["Client Name"] == client) & (df_previous["period_total"] > 0)]
        if prev_rows.empty:
            continue
        last_year_quantity = safe_float(prev_rows["period_total"].sum())
        assigned_sales_person = get_client_owner(prev_rows)
        dominant_product = get_top_product(prev_rows)
        product_breakdown = prev_rows.groupby("Product")["period_total"].sum()
        product_dependence = (product_breakdown.max() / last_year_quantity * 100) if last_year_quantity > 0 and not product_breakdown.empty else 0
        priority_score = last_year_quantity * 0.7 + product_dependence * 3
        lost_client_recovery.append({
            "client_name": client,
            "last_year_quantity": safe_int(last_year_quantity),
            "assigned_sales_person": assigned_sales_person,
            "dominant_product": dominant_product,
            "priority_score": round(priority_score, 2),
            "recovery_priority": "pending",
        })

    lost_client_recovery.sort(key=lambda x: x["priority_score"], reverse=True)
    for index, item in enumerate(lost_client_recovery):
        item["recovery_priority"] = classify_priority(index, len(lost_client_recovery))

    alerts: List[Dict[str, str]] = []
    if growth < 0:
        alerts.append({"severity": "high", "title": "Overall YTD decline", "message": f"{current_year} YTD is down {round(abs(growth), 2)}% vs {previous_year}."})
    if len(lost_clients) > len(new_clients):
        alerts.append({"severity": "medium", "title": "Replacement gap", "message": f"Lost clients ({len(lost_clients)}) are ahead of new clients ({len(new_clients)})."})
    if product_concentration_risk >= 45:
        alerts.append({"severity": "medium", "title": "Product concentration", "message": f"Top product controls {round(product_concentration_risk, 2)}% of current volume."})
    if weakest_person != "N/A":
        alerts.append({"severity": "low", "title": "Sales coaching target", "message": f"{weakest_person} is the weakest current performer by growth rate."})
    if not alerts:
        alerts.append({"severity": "low", "title": "Stable scorecard", "message": "No major exception detected in the current comparison."})

    retained_client_rate = (len(retained_clients) / len(active_clients_previous) * 100) if active_clients_previous else 0
    headline = f"{current_year} YTD is {round(growth, 2)}% {'up' if growth >= 0 else 'down'} vs {previous_year} same period."

    executive_summary = {
        "headline": headline,
        "highlights": [
            f"Top sales person is {top_sales_person}.",
            f"Top product is {top_product}.",
            f"Fastest growing product is {fastest_growing_product}.",
            f"{len(new_clients)} new clients added in the current period.",
        ],
        "risks": [
            f"{len(lost_clients)} clients are lost versus {len(new_clients)} new clients.",
            f"Product concentration risk is {round(product_concentration_risk, 2)}%.",
            f"Weakest sales person is {weakest_person}.",
        ],
        "opportunities": [
            f"Top recovery pool contains {len(lost_client_recovery)} lost clients.",
            f"Fastest product opportunity: {fastest_growing_product}.",
            f"{len([x for x in new_client_quality if x['quality_label'] == 'strong'])} strong new clients can be scaled.",
        ],
    }

    default_target = same_period_previous_total * 1.08 if same_period_previous_total > 0 else current_ytd_total
    months_remaining = max(1, 12 - len(same_period_months))
    gap = max(0, default_target - current_ytd_total)
    required_run_rate = gap / months_remaining if months_remaining else 0
    achievement_percent = (current_ytd_total / default_target * 100) if default_target else 0

    if not top_product or str(top_product).strip().lower() == "nan":
        top_product = "N/A"

    if not top_sales_person or str(top_sales_person).strip().lower() == "nan":
        top_sales_person = "N/A"

    if not weakest_person or str(weakest_person).strip().lower() == "nan":
        weakest_person = "N/A"

    return {
        "summary": {
            "current_year": current_year,
            "previous_year": previous_year,
            "this_year_sales": safe_int(current_ytd_total),
            "last_year_sales": safe_int(same_period_previous_total),
            "growth": round(growth, 2),
            "lost_clients": len(lost_clients),
            "new_clients": len(new_clients),
            "retained_clients": len(retained_clients),
            "top_product": top_product,
            "weakest_sales_person": weakest_person,
            "top_sales_person": top_sales_person,
            "available_months_count": len(same_period_months),
            "fastest_growing_product": fastest_growing_product,
            "declining_product": declining_product,
            "product_concentration_risk": round(product_concentration_risk, 2),
            "retained_client_rate": round(retained_client_rate, 2),
            "lost_vs_new_gap": len(lost_clients) - len(new_clients),
        },
        "team": team_data,
        "clients": clients_data,
        "products": product_data,
        "chart": chart_data,
        "available_months": same_period_months,
        "month_comparison": month_comparison,
        "alerts": alerts[:8],
        "lost_client_recovery": lost_client_recovery,
        "sales_scorecards": sales_scorecards,
        "salesperson_monthly_trend": salesperson_monthly_trend,
        "product_drilldown": product_drilldown,
        "client_drilldown": client_drilldown,
        "new_client_quality": new_client_quality,
        "executive_summary": executive_summary,
        "target_summary": {
            "target_bags": safe_int(default_target),
            "actual_bags": safe_int(current_ytd_total),
            "achievement_percent": round(achievement_percent, 2),
            "gap": safe_int(gap),
            "required_run_rate": safe_int(required_run_rate),
            "enabled": False,
        },
    }


def get_dashboard_payload() -> Dict[str, Any]:
    global DASHBOARD_CACHE

    if DASHBOARD_CACHE is not None:
        cached = dict(DASHBOARD_CACHE)
        cached["metadata"] = {
            **(cached.get("metadata") or {}),
            "cache_used": True,
            "ai_enabled": AI_INSIGHTS_ENABLED,
            "ai_provider": "gemini" if GEMINI_API_KEY and AI_INSIGHTS_ENABLED else "fallback",
        }
        return cached

def get_database_dashboard_payload(team: str) -> Dict[str, Any]:
    if not team.strip():
        raise HTTPException(status_code=400, detail="Team is required for database AI mode")

    df_previous, df_current, previous_year, current_year = load_database_data(team)
    payload = build_dashboard_data(df_previous, df_current, previous_year, current_year)
    payload = with_metadata(payload, source_file=f"database:{team}", cache_used=False)
    return payload
    
    
    cached_file = load_cache_file()
    if cached_file is not None:
        DASHBOARD_CACHE = cached_file
        cached_file["metadata"] = {
            **(cached_file.get("metadata") or {}),
            "cache_used": True,
            "ai_enabled": AI_INSIGHTS_ENABLED,
            "ai_provider": "gemini" if GEMINI_API_KEY and AI_INSIGHTS_ENABLED else "fallback",
        }
        return cached_file

    df_previous, df_current, previous_year, current_year = load_workbook_data()
    payload = build_dashboard_data(df_previous, df_current, previous_year, current_year)
    payload = with_metadata(payload, source_file=UPLOAD_FILE_PATH.name, cache_used=False)
    save_cache(payload)
    return payload


def fallback_salesperson_insight(item: Dict[str, Any]) -> Dict[str, Any]:
    strengths: List[str] = []
    risks: List[str] = []
    strategy: List[str] = []
    coaching_actions: List[str] = []
    root_causes: List[str] = []
    expected_impact: List[str] = []

    baseline_status = item.get("baseline_status", "normal")

    if baseline_status == "new":
        performance_label = "mixed"
        strengths.append("This appears to be a new contribution with no last-year baseline.")
        root_causes.append("Historical comparison is not available, so current output should be treated as fresh contribution rather than pure growth.")
    elif baseline_status == "no_activity":
        performance_label = "weak"
        risks.append("No activity is visible in either comparison period.")
        root_causes.append("There is no active commercial base to evaluate yet.")
    elif item["change_percent"] > 8:
        performance_label = "good"
        strengths.append(f"Growth is positive at {item['change_percent']}%, which shows healthy momentum.")
    elif item["change_percent"] > 0:
        performance_label = "mixed"
        strengths.append(f"Growth is slightly positive at {item['change_percent']}%, which shows some momentum.")
        root_causes.append("Growth exists, but it is not yet strong enough to absorb losses elsewhere.")
    else:
        performance_label = "weak"
        risks.append(f"Growth is {item['change_percent']}%, so this account base needs recovery focus.")
        root_causes.append("Negative growth suggests either volume drop in retained accounts or weak replacement of lost business.")

    if item["new_clients"] > 0:
        strengths.append(f"{item['new_clients']} new clients were added.")
    else:
        risks.append("No new client addition is visible in the current comparison.")
        root_causes.append("Pipeline conversion looks weak because no new accounts were added.")

    if item["lost_clients"] > 0:
        risks.append(f"{item['lost_clients']} clients were lost and should be reviewed.")
        strategy.append("Start with lost-client recovery and prioritize the highest quantity accounts first.")
        coaching_actions.append("Call top lost accounts within 48 hours and log the exact loss reason.")
        expected_impact.append("Recovering even 1-2 lost high-volume accounts can improve short-term revenue quickly.")

    if item["retained_clients"] > 0:
        strengths.append(f"{item['retained_clients']} clients were retained, which gives a base to cross-sell.")
        coaching_actions.append("Push the top product into retained clients with repeat-order potential.")

    if item["recovery_opportunity"] > 0:
        strategy.append(f"Recovery opportunity is {item['recovery_opportunity']} bags, so reactivation should be a priority.")
        expected_impact.append("A focused recovery campaign can unlock dormant volume without waiting for new lead cycles.")

    strategy.append(f"Push top product {item['top_product']} into retained accounts where possible.")
    strategy.append("Do weekly follow-up with retained clients and review inactive accounts early.")
    coaching_actions.append("Review the account list weekly and separate retained, new, and lost clients into different call plans.")

    return {
        "salesperson_name": item["name"],
        "provider": "fallback",
        "summary": (
            f"{item['name']} handled {item['this_year']} bags this year vs {item['last_year']} last year. "
            "This should be treated as a fresh contribution, not a pure growth comparison."
            if item.get("baseline_status") == "new"
            else (
                f"{item['name']} has no activity in either comparison period, so a meaningful growth judgement is not available."
                if item.get("baseline_status") == "no_activity"
                else f"{item['name']} handled {item['this_year']} bags this year vs {item['last_year']} last year. Focus is strongest when retained accounts are protected and lost accounts are recovered quickly."
            )
        ),
        "strengths": strengths[:4] or ["Current performance shows a stable working base."],
        "risks": risks[:4] or ["No major risk surfaced from the current scorecard."],
        "strategy": strategy[:5] or ["Keep follow-up regular on retained and recently added clients."],
        "manager_note": f"Manager should review {item['name']} on retention discipline, lost-client recovery, and repeat-order expansion using top product {item['top_product']}.",
        "performance_label": performance_label,
        "confidence": "basic-rule-based",
        "root_causes": root_causes[:4] or ["The scorecard alone suggests stable performance but not enough depth for a stronger diagnosis."],
        "coaching_actions": coaching_actions[:5] or ["Review top retained accounts every week and protect repeat orders."],
        "risk_alerts": risks[:4] or ["No immediate red flag from rule-based analysis."],
        "next_30_day_plan": coaching_actions[:5] or ["Run a weekly follow-up routine on retained and recently active accounts."],
        "expected_impact": expected_impact[:4] or ["Consistent follow-up should stabilize the existing base and improve repeat volume."],
    }


def pick_top_rows(items: List[Dict[str, Any]], limit: int, sort_key: str) -> List[Dict[str, Any]]:
    return sorted(items, key=lambda x: x.get(sort_key, 0), reverse=True)[:limit]


def monthly_commentary(monthly_trend: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not monthly_trend:
        return {"best_month": "N/A", "worst_month": "N/A", "latest_month": "N/A"}

    with_delta = []
    for row in monthly_trend:
        delta = safe_float(row.get("current", 0)) - safe_float(row.get("previous", 0))
        with_delta.append({**row, "delta": delta})

    best = max(with_delta, key=lambda x: x["delta"])
    worst = min(with_delta, key=lambda x: x["delta"])
    latest = with_delta[-1]
    return {"best_month": best["month"], "worst_month": worst["month"], "latest_month": latest["month"]}


def compute_performance_score(scorecard: Dict[str, Any], dashboard_summary: Dict[str, Any]) -> float:
    growth_component = float(scorecard.get("change_percent", 0)) * 0.45
    retention_base = max(1, float(scorecard.get("retained_clients", 0)) + float(scorecard.get("lost_clients", 0)))
    retention_rate = (float(scorecard.get("retained_clients", 0)) / retention_base) * 100
    retention_component = retention_rate * 0.35
    acquisition_component = float(scorecard.get("new_clients", 0)) * 3.0
    loss_penalty = float(scorecard.get("lost_clients", 0)) * 4.0
    recovery_component = min(float(scorecard.get("recovery_opportunity", 0)) / 100.0, 12.0)
    concentration_penalty = float(dashboard_summary.get("product_concentration_risk", 0)) * 0.05
    score = growth_component + retention_component + acquisition_component + recovery_component - loss_penalty - concentration_penalty
    return round(score, 2)


def get_performance_band(score: float) -> str:
    if score >= 45:
        return "excellent"
    if score >= 25:
        return "good"
    if score >= 8:
        return "mixed"
    return "weak"

def classify_baseline_status(last_year: float, this_year: float) -> str:
    if last_year == 0 and this_year > 0:
        return "new"
    if last_year == 0 and this_year == 0:
        return "no_activity"
    return "normal"

def build_salesperson_context(name: str, dashboard_payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    scorecard = next((item for item in dashboard_payload.get("sales_scorecards", []) if item.get("name") == name), None)
    if not scorecard:
        return None

    client_rows = [item for item in dashboard_payload.get("client_drilldown", []) if item.get("assigned_sales_person") == name]
    product_rows = [item for item in dashboard_payload.get("product_drilldown", []) if item.get("top_sales_person") == name]
    new_client_rows = [item for item in dashboard_payload.get("new_client_quality", []) if item.get("sales_person") == name]
    recovery_rows = [item for item in dashboard_payload.get("lost_client_recovery", []) if item.get("assigned_sales_person") == name]
    dashboard_summary = dashboard_payload.get("summary", {})

    lost_clients = pick_top_rows([row for row in client_rows if row.get("status") == "lost"], 5, "previous_year_quantity")
    retained_clients = pick_top_rows([row for row in client_rows if row.get("status") == "retained"], 5, "current_year_quantity")
    new_clients = pick_top_rows([row for row in new_client_rows], 5, "quantity")
    product_focus = pick_top_rows(product_rows, 5, "this_year_sales")

    top_product_name = scorecard.get("top_product")
    top_product_row = next((row for row in product_focus if row.get("name") == top_product_name), None)
    monthly_story = monthly_commentary((top_product_row or {}).get("monthly_trend", []))
    performance_score = compute_performance_score(scorecard, dashboard_summary)

    return {
        "dashboard_summary": dashboard_summary,
        "executive_summary": dashboard_payload.get("executive_summary", {}),
        "scorecard": scorecard,
        "baseline_status": scorecard.get("baseline_status", "normal"),
        "performance_score": performance_score,
        "performance_band": get_performance_band(performance_score),
        "product_focus": product_focus,
        "lost_clients": lost_clients,
        "retained_clients": retained_clients,
        "new_clients": new_clients,
        "recovery_pool": recovery_rows[:5],
        "monthly_commentary": monthly_story,
        "manager_focus": {
            "top_risk_count": len(lost_clients),
            "retained_base_count": len(retained_clients),
            "new_client_count": len(new_clients),
            "recovery_pool_count": len(recovery_rows),
        },
    }


def build_gemini_prompt(context: Dict[str, Any]) -> str:
    return (
        "You are a senior sales strategist and account-retention advisor. "
        "Analyze the salesperson data deeply and return ONLY valid JSON without markdown.\n\n"

        "JSON schema:\n"
        "{"
        '"summary":"short evaluation",'
        '"strengths":["max 4"],'
        '"risks":["max 4"],'
        '"root_causes":["max 4"],'
        '"strategy":["max 5"],'
        '"coaching_actions":["max 5"],'
        '"risk_alerts":["max 4"],'
        '"next_30_day_plan":["max 5"],'
        '"expected_impact":["max 4"],'
        '"manager_note":"short manager note",'
        '"performance_label":"excellent|good|mixed|weak",'
        '"confidence":"high|medium|low"'
        "}\n\n"

        "Rules:\n"
        "- Analyze visit_summary when available.\n"
        "- Detect high visits with low/no orders.\n"
        "- Highlight repeated non-converting visits.\n"
        "- Mention weak conversion efficiency clearly.\n"
        "- Suggest continue/escalate/stop visit actions where relevant.\n"
        "- Be direct, practical, and evidence-based.\n"
        "- Mention strengths and weak areas honestly.\n"
        "- Root causes must explain WHY performance changed.\n"
        "- Strategy and coaching must be operational and actionable.\n"
        "- If growth is negative or lost clients are high, say it clearly.\n"
        "- Keep responses concise and business-focused.\n"

        "Business rules:\n"
        "- Quantities may be in KG or Bags.\n"
        "- NEVER treat quantities as money or revenue.\n"
        "- NEVER use $, USD, PKR, or currency symbols.\n"
        "- Always mention quantities with unit labels.\n"
        "- Detect years dynamically from data.\n"
        "- If only latest-year activity exists, treat salesperson as new/current-year contributor.\n"
        "- If multiple years exist, perform year-over-year comparison.\n"
        "- If latest-year activity is missing, treat as inactive/recovery case.\n"
        "- Do not call clients lost without historical baseline.\n"
        "- If visits are high but quantities are declining, highlight poor effectiveness.\n"
        "- Manager notes should be accountability-focused.\n"

        f"\nDATA:\n{json.dumps(context, ensure_ascii=False, separators=(',', ':'))}"
    )


def extract_text_from_gemini_response(payload: Dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise ValueError("No Gemini candidates returned")

    parts = candidates[0].get("content", {}).get("parts", [])
    text_chunks = [part.get("text", "") for part in parts if isinstance(part, dict)]
    text = "\n".join(chunk for chunk in text_chunks if chunk).strip()
    if not text:
        raise ValueError("Gemini returned empty text")
    return text


def clean_json_text(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(%s:json)%s\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    return text.strip()


def normalize_string_list(value: Any, limit: int) -> List[str]:
    if not isinstance(value, list):
        return []
    items = []
    for item in value:
        text = str(item).strip()
        if text:
            items.append(text)
    return items[:limit]

def call_ai_json(prompt: str) -> Dict[str, Any]:
    provider = (AI_SETTINGS or {}).get("provider", "gemini").lower()

    if provider == "openai":
        return call_openai_json(prompt)

    if provider == "claude":
        return call_claude_json(prompt)

    primary_model = (AI_SETTINGS or {}).get("model") or GEMINI_MODEL
    fallback_model = (AI_SETTINGS or {}).get("fallback_model")

    try:
        return call_gemini_json(prompt, model_override=primary_model)
    except Exception as primary_error:
        if fallback_model and fallback_model != primary_model:
            try:
                print(
                    f"Primary Gemini model failed: {primary_model}. Trying fallback: {fallback_model}",
                    flush=True,
                )
                return call_gemini_json(prompt, model_override=fallback_model)
            except Exception as fallback_error:
                raise RuntimeError(
                    f"Primary Gemini failed: {primary_error} | Fallback Gemini failed: {fallback_error}"
                ) from fallback_error

        raise primary_error

def call_gemini_json(prompt: str, model_override: str | None = None) -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        raise RuntimeError("Missing GEMINI_API_KEY")

    model_to_use = model_override or GEMINI_MODEL

    url = f"https://generativelanguage.googleapis.com/v1/models/{model_to_use}:generateContent?key={GEMINI_API_KEY}"

    print("CALLING GEMINI MODEL:", model_to_use, flush=True)
    print("CALLING GEMINI KEY LAST 6:", GEMINI_API_KEY[-6:] if GEMINI_API_KEY else "NO KEY", flush=True)
    body = {
        "generationConfig": {
            "temperature": 0.3,
            "topP": 0.9,            
        },
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini HTTP {exc.code}: {detail[:400]}") from exc
    except Exception as exc:
        raise RuntimeError(f"Gemini request failed: {str(exc)}") from exc

    parsed = json.loads(raw)
    text = extract_text_from_gemini_response(parsed)
    cleaned = clean_json_text(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Gemini JSON parse failed: {str(exc)} | raw={cleaned[:400]}") from exc

def call_openai_json(prompt: str) -> Dict[str, Any]:
    return {
        "summary": "OpenAI provider configured successfully.",
        "strengths": [],
        "risks": [],
        "root_causes": [],
        "strategy": [],
        "coaching_actions": [],
        "risk_alerts": [],
        "next_30_day_plan": [],
        "expected_impact": [],
        "manager_note": "OpenAI API key not configured yet.",
        "performance_label": "mixed",
        "confidence": "low"
    }

def call_claude_json(prompt: str) -> Dict[str, Any]:
    return {
        "summary": "Claude provider configured successfully.",
        "strengths": [],
        "risks": [],
        "root_causes": [],
        "strategy": [],
        "coaching_actions": [],
        "risk_alerts": [],
        "next_30_day_plan": [],
        "expected_impact": [],
        "manager_note": "Claude API key not configured yet.",
        "performance_label": "mixed",
        "confidence": "low"
    }

def generate_salesperson_insight(item: Dict[str, Any], dashboard_payload: Dict[str, Any]) -> Dict[str, Any]:
    fallback = fallback_salesperson_insight(item)

    if not (AI_INSIGHTS_ENABLED and GEMINI_API_KEY):
        return fallback

    context = build_salesperson_context(item["name"], dashboard_payload)

    if not context:
        return fallback

    visit_data = get_salesperson_visit_summary(item["name"])
    context["visit_summary"] = visit_data

    try:
        prompt = build_gemini_prompt(context)
        model_result = call_ai_json(prompt)
        return {
            "salesperson_name": item["name"],
            "provider": (AI_SETTINGS or {}).get("provider", "gemini"),
            "summary": str(model_result.get("summary") or fallback["summary"]),
            "strengths": normalize_string_list(model_result.get("strengths"), 4) or fallback["strengths"],
            "risks": normalize_string_list(model_result.get("risks"), 4) or fallback["risks"],
            "root_causes": normalize_string_list(model_result.get("root_causes"), 4) or fallback.get("root_causes", []),
            "strategy": normalize_string_list(model_result.get("strategy"), 5) or fallback["strategy"],
            "coaching_actions": normalize_string_list(model_result.get("coaching_actions"), 5) or fallback.get("coaching_actions", []),
            "risk_alerts": normalize_string_list(model_result.get("risk_alerts"), 4) or fallback.get("risk_alerts", []),
            "next_30_day_plan": normalize_string_list(model_result.get("next_30_day_plan"), 5) or fallback.get("next_30_day_plan", []),
            "expected_impact": normalize_string_list(model_result.get("expected_impact"), 4) or fallback.get("expected_impact", []),
            "manager_note": str(model_result.get("manager_note") or fallback["manager_note"]),
            "performance_label": str(model_result.get("performance_label") or context.get("performance_band") or "mixed"),
            "confidence": str(model_result.get("confidence") or "medium"),
            "performance_score": context.get("performance_score"),
            "baseline_status": context.get("baseline_status", "normal"),
        }
    except Exception as exc:
        fallback["error"] = str(exc)
        fallback["provider"] = "fallback"
        fallback["performance_score"] = context.get("performance_score")
        fallback["baseline_status"] = context.get("baseline_status", "normal")
        return fallback


def get_local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def maybe_open_browser():
    try:
        webbrowser.open("http://127.0.0.1:8000")
    except Exception:
        pass

class UserRegisterRequest(BaseModel):
    username: str
    password: str
    team: str
    role: str = "user"

class UserLoginRequest(BaseModel):
    username: str
    password: str

@app.post("/register")
def register_user(payload: UserRegisterRequest):
    # Public registration is disabled by default for security.
    # Use /admin/create-user after admin login to create users.
    if os.getenv("ALLOW_PUBLIC_REGISTER", "false").lower() != "true":
        raise HTTPException(status_code=403, detail="Public registration is disabled. Admin must create users.")

    username = payload.username.strip()
    password = payload.password.strip()
    team = payload.team.strip() if payload.team else ""

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")

    if not team:
        raise HTTPException(status_code=400, detail="Please select the team first")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        role = payload.role.strip() if payload.role else "user"

        if role not in {"user", "team_leader", "super_user"}:
            raise HTTPException(status_code=400, detail="Invalid role")

        cur.execute(
            """
            INSERT INTO users (username, password, role, team, sales_target, target_duration)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                username,
                hash_password(password),
                role,
                team,
                getattr(payload, "sales_target", 0),
                getattr(payload, "target_duration", "monthly"),
            ),
        )

        conn.commit()
        return {"status": "success", "message": "User registered"}
    except Exception:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()

@app.post("/login")
def login_user(payload: UserLoginRequest):
    username = payload.username.strip()
    password = payload.password.strip()

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, username, password, role, team FROM users WHERE username = %s", (username,))
        user = cur.fetchone()

        if not user or not verify_password(password, user[2]):
            raise HTTPException(status_code=401, detail="Invalid username or password")

        token = create_access_token({
            "user_id": user[0],
            "username": user[1],
            "role": user[3],
            "team": user[4] or "",
        })

        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {
                "id": user[0],
                "username": user[1],
                "role": user[3],
                "team": user[4],
            }
        }
    finally:
        conn.close()

from jose import JWTError, jwt
from auth_utils import SECRET_KEY, ALGORITHM

def get_current_user(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Login required")

    token = authorization.replace("Bearer ", "").strip()

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def require_admin(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user

@app.post("/admin/create-user")
def admin_create_user(payload: UserRegisterRequest, user: dict = Depends(require_admin)):
    username = payload.username.strip()
    password = payload.password.strip()
    team = payload.team.strip() if payload.team else ""

    role = payload.role.strip() if payload.role else "user"

    if role not in {"user", "team_leader", "super_user"}:
        raise HTTPException(status_code=400, detail="Invalid role")

    if role != "super_user" and not team:
        raise HTTPException(status_code=400, detail="Please select the team first")

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO users (username, password, role, team) VALUES (%s, %s, %s, %s)",
            (username, hash_password(password), role, team),
        )
        conn.commit()
        return {"status": "success", "message": "User created successfully"}
    except Exception:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()

@app.get("/admin/ai-settings")
def get_admin_ai_settings(user: dict = Depends(require_admin)):
    settings = get_ai_settings()

    if not settings:
        return {
            "provider": "gemini",
            "model": "gemini-1.5-flash",
            "fallback_model": "gemini-1.5-flash",
            "api_key": "",
            "timeout_seconds": 180,
            "enabled": True,
        }

    safe_settings = settings.copy()

    if safe_settings.get("api_key"):
        safe_settings["api_key"] = "********"

    return safe_settings

@app.put("/admin/ai-settings")
def update_admin_ai_settings(payload: AISettingsUpdate, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()

    existing_settings = get_ai_settings()

    api_key_to_save = (
        existing_settings["api_key"]
        if payload.api_key == "********"
        else payload.api_key
    )

    cur.execute("""
        UPDATE ai_settings
        SET
            provider = %s,
            model = %s,
            fallback_model = %s,
            api_key = %s,
            timeout_seconds = %s,
            enabled = %s,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = (
            SELECT id
            FROM ai_settings
            ORDER BY id DESC
            LIMIT 1
        )
    """, (
        payload.provider,
        payload.model,
        payload.fallback_model,
        api_key_to_save,
        payload.timeout_seconds,
        payload.enabled
    ))

    conn.commit()

    cur.close()
    conn.close()

    global AI_SETTINGS
    global GEMINI_API_KEY
    global GEMINI_MODEL
    global GEMINI_TIMEOUT_SECONDS

    try:
        ensure_database_schema()
        AI_SETTINGS = get_ai_settings()
    except Exception as exc:
        print("AI SETTINGS LOAD SKIPPED:", str(exc), flush=True)
        AI_SETTINGS = None
    
    GEMINI_API_KEY = AI_SETTINGS["api_key"]
    GEMINI_MODEL = AI_SETTINGS["model"]
    GEMINI_TIMEOUT_SECONDS = AI_SETTINGS["timeout_seconds"]
    global AI_INSIGHTS_ENABLED

    AI_INSIGHTS_ENABLED = AI_SETTINGS["enabled"]

    return {
        "success": True,
        "message": "AI settings updated successfully"
    }

@app.post("/admin/test-ai")
def test_ai_connection(user: dict = Depends(require_admin)):
    if not AI_INSIGHTS_ENABLED:
        raise HTTPException(status_code=400, detail="AI is disabled in settings")

    if not GEMINI_API_KEY:
        raise HTTPException(status_code=400, detail="AI API key is missing")

    try:
        result = call_ai_json(
            'Return only valid JSON: {"status":"ok","message":"AI connection successful"}'
        )

        return {
            "success": True,
            "provider": (AI_SETTINGS or {}).get("provider", "gemini"),
            "model": (AI_SETTINGS or {}).get("model", GEMINI_MODEL),
            "message": result.get("message", "AI connection successful"),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"AI test failed: {str(exc)}"
        )

@app.get("/admin/users")
def admin_list_users(user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, username, role, team, sales_target, target_duration FROM users ORDER BY id DESC")
        rows = cur.fetchall()
        return {
            "users": [
                {
                    "id": row[0],
                    "username": row[1],
                    "role": row[2],
                    "team": row[3] or "",
                    "sales_target": row[4] or 0,
                    "target_duration": row[5] or "monthly",
                }
                for row in rows
            ]
        }
    finally:
        conn.close()


@app.delete("/admin/delete-user/{user_id}")
def admin_delete_user(user_id: int, user: dict = Depends(require_admin)):
    if user.get("user_id") == user_id:
        raise HTTPException(status_code=400, detail="Admin apna account delete nahi kar sakta")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        return {"status": "success", "message": "User deleted successfully"}
    finally:
        conn.close()


class AdminResetPasswordRequest(BaseModel):
    password: str


@app.put("/admin/reset-password/{user_id}")
def admin_reset_password(user_id: int, payload: AdminResetPasswordRequest, user: dict = Depends(require_admin)):
    password = payload.password.strip()
    if not password:
        raise HTTPException(status_code=400, detail="Password required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE users SET password = %s WHERE id = %s",
            (hash_password(password), user_id)
        )
        conn.commit()
        return {"status": "success", "message": "Password reset successfully"}
    finally:
        conn.close()

class NameRequest(BaseModel):
    name: str
    target_type: str = "QTY"

class UserTargetUpdateRequest(BaseModel):
    sales_target: float = 0
    target_duration: str = "monthly"

class MonthlyTargetRequest(BaseModel):
    username: str
    team: str
    year: int
    month: str
    target_kg: float = 0
    target_type: str = "QTY"
    target_value: float = 0

class BossAgentRequest(BaseModel):
    question: str
    team: str = ""

@app.get("/api/teams")
def list_teams(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, name, COALESCE(target_type, 'QTY') FROM teams ORDER BY name")
        rows = cur.fetchall()
        return {
            "teams": [
                {"id": r[0], "name": r[1], "target_type": r[2]}
                for r in rows
            ]
        }
    finally:
        conn.close()


@app.post("/api/teams")
def add_team(payload: NameRequest, user: dict = Depends(require_admin)):
    name = payload.name.strip()
    target_type = (payload.target_type or "QTY").strip().upper()

    if target_type not in {"QTY", "AMOUNT"}:
        target_type = "QTY"

    if not name:
        raise HTTPException(status_code=400, detail="Team name required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO teams (name, target_type) VALUES (%s, %s)",
            (name, target_type)
        )
        conn.commit()
        return {"status": "ok", "message": "Team added"}
    except Exception:
        raise HTTPException(status_code=400, detail="Team already exists")
    finally:
        conn.close()

@app.put("/api/teams/{team_id}")
def update_team(team_id: int, payload: NameRequest, user: dict = Depends(require_admin)):
    name = payload.name.strip()
    target_type = (payload.target_type or "QTY").strip().upper()

    if target_type not in {"QTY", "AMOUNT"}:
        target_type = "QTY"

    if not name:
        raise HTTPException(status_code=400, detail="Team name required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE teams SET name = %s, target_type = %s WHERE id = %s",
            (name, target_type, team_id)
        )

        
        conn.commit()
        return {"status": "ok", "message": "Team updated"}
    finally:
        conn.close()


@app.delete("/api/teams/{team_id}")
def delete_team(team_id: int, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM teams WHERE id = %s", (team_id,))
        conn.commit()
        return {"status": "ok", "message": "Team deleted"}
    finally:
        conn.close()

@app.post("/api/products/upload")
def upload_products(file: UploadFile = File(...), user: dict = Depends(require_admin)):
    import pandas as pd

    df = pd.read_excel(file.file)
    df.columns = [c.strip().lower() for c in df.columns]

    if "name" not in df.columns:
        raise HTTPException(status_code=400, detail="Excel must have 'name' column")

    names = df["name"].dropna().astype(str).str.strip().unique()

    conn = get_db_connection()
    cur = conn.cursor()

    added = 0

    for name in names:
        cur.execute(
            "INSERT INTO products (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
            (name,)
        )
        if cur.rowcount > 0:
            added += 1

    conn.commit()
    conn.close()

    return {"status": "ok", "added": added}

@app.get("/api/clients")
def list_clients(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, name FROM clients ORDER BY name")
        rows = cur.fetchall()
        return {"clients": [{"id": r[0], "name": r[1]} for r in rows]}
    finally:
        conn.close()


@app.post("/api/clients")
def add_client(payload: NameRequest, user: dict = Depends(get_current_user)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Client name required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("INSERT INTO clients (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (name,))
        conn.commit()
        return {"status": "ok", "message": "Client added", "name": name}
    finally:
        conn.close()

@app.get("/api/products")
def list_products(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, name FROM products ORDER BY name")
        rows = cur.fetchall()
        return {"products": [{"id": r[0], "name": r[1]} for r in rows]}
    finally:
        conn.close()


@app.post("/api/products")
def add_product(payload: NameRequest, user: dict = Depends(require_admin)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Product name required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("INSERT INTO products (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (name,))
        conn.commit()
        return {"status": "ok", "message": "Product added"}
    except Exception:
        raise HTTPException(status_code=400, detail="Product already exists")
    finally:
        conn.close()


@app.delete("/api/products/{product_id}")
def delete_product(product_id: int, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM products WHERE id = %s", (product_id,))
        conn.commit()
        return {"status": "ok", "message": "Product deleted"}
    finally:
        conn.close()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "has_upload": UPLOAD_FILE_PATH.exists(),
        "has_cache_file": CACHE_FILE_PATH.exists(),
        "cached_in_memory": DASHBOARD_CACHE is not None,
        "timestamp": now_iso(),
        "ai_enabled": AI_INSIGHTS_ENABLED,
        "gemini_configured": bool(GEMINI_API_KEY),
        "gemini_model": GEMINI_MODEL,
    }


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file selected")
    if not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Only Excel files are allowed")

    try:
        contents = await file.read()

        max_file_size_bytes = 10 * 1024 * 1024  # 10 MB
        if len(contents) > max_file_size_bytes:
            raise HTTPException(
                status_code=400,
                detail="File is too large. Please upload an Excel file smaller than 10 MB."
            )
        
        with open(UPLOAD_FILE_PATH, "wb") as handle:
            handle.write(contents)

        df_previous, df_current, previous_year, current_year = load_workbook_data()
        dashboard = build_dashboard_data(df_previous, df_current, previous_year, current_year)
        dashboard = with_metadata(dashboard, source_file=file.filename, cache_used=False)
        save_cache(dashboard)
        return {"message": "File uploaded successfully", "dashboard": dashboard}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(exc)}") from exc


@app.get("/dashboard")
def dashboard():
    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    if not UPLOAD_FILE_PATH.exists():
        return JSONResponse(
            content={
                "summary": {
                    "current_year": None,
                    "previous_year": None,
                    "this_year_sales": 0,
                    "last_year_sales": 0,
                    "growth": 0,
                    "lost_clients": 0,
                    "new_clients": 0,
                    "retained_clients": 0,
                    "top_product": "N/A",
                    "weakest_sales_person": "N/A",
                    "top_sales_person": "N/A",
                    "available_months_count": 0,
                    "fastest_growing_product": "N/A",
                    "declining_product": "N/A",
                    "product_concentration_risk": 0,
                    "retained_client_rate": 0,
                    "lost_vs_new_gap": 0,
                },
                "team": [],
                "clients": [],
                "products": [],
                "chart": [],
                "available_months": [],
                "month_comparison": [],
                "alerts": [
                    {
                        "severity": "low",
                        "title": "No upload yet",
                        "message": "Please upload an Excel workbook to load the dashboard."
                    }
                ],
                "lost_client_recovery": [],
                "sales_scorecards": [],
                "product_drilldown": [],
                "client_drilldown": [],
                "new_client_quality": [],
                "executive_summary": {
                    "headline": "No data loaded",
                    "highlights": [],
                    "risks": [],
                    "opportunities": [],
                },
                "target_summary": {
                    "target_bags": 0,
                    "actual_bags": 0,
                    "achievement_percent": 0,
                    "gap": 0,
                    "required_run_rate": 0,
                    "enabled": False,
                },
                "metadata": {
                    "source_file": None,
                    "last_processed_at": now_iso(),
                    "cache_used": False,
                    "ai_enabled": AI_INSIGHTS_ENABLED,
                    "ai_provider": "gemini" if GEMINI_API_KEY and AI_INSIGHTS_ENABLED else "fallback",
                    "empty_state": True,
                },
            },
            headers=headers,
        )

    return JSONResponse(content=get_dashboard_payload(), headers=headers)

@app.get("/dashboard/db")
def dashboard_from_db(team: str = "", user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM teams ORDER BY name")
        available_teams = [row[0] for row in cur.fetchall()]
    finally:
        conn.close()

    if user.get("role") == "user":
        user_team = str(user.get("team", "")).strip()
        if team and team != user_team:
            raise HTTPException(status_code=403, detail="You can only view your assigned team")

    if user.get("role") == "team_leader":
        leader_team = str(user.get("team", "")).strip()
        if team and team != leader_team:
            raise HTTPException(status_code=403, detail="Team leader can only view assigned team")
    
    if not team:
        return {
            "summary": {
                "current_year": None,
                "previous_year": None,
                "this_year_sales": 0,
                "last_year_sales": 0,
                "growth": 0,
                "lost_clients": 0,
                "new_clients": 0,
                "retained_clients": 0,
                "top_product": "N/A",
                "weakest_sales_person": "N/A",
                "top_sales_person": "N/A",
                "available_months_count": 0,
                "fastest_growing_product": "N/A",
                "declining_product": "N/A",
                "product_concentration_risk": 0,
                "retained_client_rate": 0,
                "lost_vs_new_gap": 0,
            },
            "team": [],
            "clients": [],
            "products": [],
            "chart": [],
            "available_months": [],
            "month_comparison": [],
            "alerts": [],
            "lost_client_recovery": [],
            "sales_scorecards": [],
            "salesperson_monthly_trend": [],
            "product_drilldown": [],
            "client_drilldown": [],
            "new_client_quality": [],
            "executive_summary": {
                "headline": "No data loaded",
                "highlights": [],
                "risks": [],
                "opportunities": [],
            },
            "target_summary": {
                "target_bags": 0,
                "actual_bags": 0,
                "achievement_percent": 0,
                "gap": 0,
                "required_run_rate": 0,
                "enabled": False,
            },
            "metadata": {
                "available_teams": available_teams,
                "source_file": "database",
                "empty_state": True,
            },
        }

    try:
        df_previous, df_current, previous_year, current_year = load_database_data(team)
    except HTTPException as exc:
        if exc.status_code == 404:
            return {
                "summary": {
                    "current_year": None,
                    "previous_year": None,
                    "this_year_sales": 0,
                    "last_year_sales": 0,
                    "growth": 0,
                    "lost_clients": 0,
                    "new_clients": 0,
                    "retained_clients": 0,
                    "top_product": "N/A",
                    "weakest_sales_person": "N/A",
                    "top_sales_person": "N/A",
                    "available_months_count": 0,
                    "fastest_growing_product": "N/A",
                    "declining_product": "N/A",
                    "product_concentration_risk": 0,
                    "retained_client_rate": 0,
                    "lost_vs_new_gap": 0,
                },
                "team": [],
                "clients": [],
                "products": [],
                "chart": [],
                "available_months": [],
                "month_comparison": [],
                "alerts": [],
                "lost_client_recovery": [],
                "sales_scorecards": [],
                "salesperson_monthly_trend": [],
                "product_drilldown": [],
                "client_drilldown": [],
                "new_client_quality": [],
                "executive_summary": {
                    "headline": f"No data loaded for {team}",
                    "highlights": [],
                    "risks": [],
                    "opportunities": [],
                },
                "target_summary": {
                    "target_bags": 0,
                    "actual_bags": 0,
                    "achievement_percent": 0,
                    "gap": 0,
                    "required_run_rate": 0,
                    "enabled": False,
                },
                "metadata": {
                    "available_teams": available_teams,
                    "source_file": f"database:{team}",
                    "selected_team": team,
                    "empty_state": True,
                },
            }
        raise

    payload = build_dashboard_data(df_previous, df_current, previous_year, current_year)

    metadata = payload.get("metadata", {}) or {}
    metadata["available_teams"] = available_teams
    metadata["source_file"] = f"database:{team}"
    metadata["selected_team"] = team
    payload["metadata"] = metadata

    return payload

@app.get("/form/options")
def get_form_options(team: str = ""):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        teams = fetch_lookup_values(conn, "teams")

        team = (team or "").strip()
        if not team:
            return {
                "teams": teams,
                "sales_people": [],
                "clients": [],
                "products": [],
            }

        cur.execute("""
            SELECT DISTINCT sales_person
            FROM sales_entries
            WHERE team = %s
            ORDER BY sales_person
        """, (team,))
        sales_people = [
            row[0] for row in cur.fetchall()
            if row[0] and str(row[0]).strip().lower() not in {"nan", "none"}
        ]

        cur.execute("""
            SELECT name FROM (
                SELECT DISTINCT client_name AS name
                FROM sales_entries
                WHERE team = %s

                UNION

                SELECT name
                FROM clients
            ) x
            ORDER BY name
        """, (team,))
        clients = [
            row[0] for row in cur.fetchall()
            if row[0] and str(row[0]).strip().lower() not in {"nan", "none"}
        ]

        cur.execute("""
            SELECT DISTINCT product
            FROM sales_entries
            WHERE team = %s
            ORDER BY product
        """, (team,))
        products = [
            row[0] for row in cur.fetchall()
            if row[0] and str(row[0]).strip().lower() not in {"nan", "none"}
        ]

        return {
            "teams": teams,
            "sales_people": sales_people,
            "clients": clients,
            "products": products,
        }
    finally:
        conn.close()


@app.post("/form/team")
def add_team(payload: dict):
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Team name is required")

    conn = get_db_connection()
    try:
        ensure_lookup_value(conn, "teams", name)
        return {"status": "success", "team": name}
    finally:
        conn.close()


@app.put("/form/team/rename")
def rename_team(payload: dict):
    old_name = str(payload.get("old_name", "")).strip()
    new_name = str(payload.get("new_name", "")).strip()

    if not old_name or not new_name:
        raise HTTPException(status_code=400, detail="Old name and new name are required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("UPDATE teams SET name = %s WHERE name = %s", (new_name, old_name))
        cur.execute("UPDATE sales_entries SET team = %s WHERE team = %s", (new_name, old_name))
        conn.commit()
        return {"status": "success", "old_name": old_name, "new_name": new_name}
    finally:
        conn.close()

@app.get("/data-entry")
def data_entry_page(user: dict = Depends(get_current_user)):
    if not DATA_ENTRY_HTML_PATH.exists():
        raise HTTPException(status_code=404, detail="Data entry page not found")
    return FileResponse(DATA_ENTRY_HTML_PATH)

@app.post("/data/entry")
def add_entry(entry: dict, user: dict = Depends(get_current_user)):
    if user.get("role") in {"admin", "super_user"}:
        team = str(entry.get("team", "")).strip()
        sales_person = str(entry.get("sales_person", "")).strip()
    else:
        team = str(user.get("team", "")).strip()
        sales_person = str(user.get("username", "")).strip()
    client_name = str(entry.get("client_name", "")).strip()
    client_category = str(entry.get("client_category", "")).strip()
    product = str(entry.get("product", "")).strip()
    entry_date = str(entry.get("entry_date", "")).strip()
    quantity = entry.get("quantity")
    amount = entry.get("amount", 0)

    if not team or not sales_person or not client_name or not product or not entry_date:
        raise HTTPException(
            status_code=400,
            detail="team, sales_person, client_name, client_category, product, entry_date are required",
        )

    if quantity in (None, "", []):
        raise HTTPException(status_code=400, detail="quantity is required")

    try:
        quantity = float(quantity)
        amount = float(amount or 0)
        year = year_from_date(entry_date)
        month = month_from_date(entry_date)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date, quantity or amount: {str(exc)}") from exc

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        ensure_lookup_value(conn, "teams", team)
        ensure_lookup_value(conn, "sales_people", sales_person)
        ensure_lookup_value(conn, "clients", client_name)
        ensure_lookup_value(conn, "products", product)

        cur.execute("""
        INSERT INTO sales_entries (team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            team,
            sales_person,
            client_name,
            client_category,
            product,            
            year,
            month,
            quantity,
            amount,
            entry_date,
        ))

        conn.commit()
        return {
            "status": "success",
            "saved": {
                "team": team,
                "sales_person": sales_person,
                "client_name": client_name,
                "product": product,
                "year": year,
                "month": month,
                "quantity": quantity,
                "entry_date": entry_date,
            }
        }
    finally:
        conn.close()

@app.get("/data/entries")
def list_data_entries(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        if user.get("role") in {"admin", "super_user"}:
            cur.execute("""
                SELECT id, team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date
                FROM sales_entries
                ORDER BY entry_date DESC, id DESC
            """)
        elif user.get("role") == "team_leader":
            cur.execute("""
                SELECT id, team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date
                FROM sales_entries
                WHERE team = %s
                ORDER BY entry_date DESC, id DESC
            """, (user.get("team", ""),))
        else:
            cur.execute("""
                SELECT id, team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date
                FROM sales_entries
                WHERE sales_person = %s AND team = %s
                ORDER BY entry_date DESC, id DESC
            """, (user.get("username", ""), user.get("team", "")))

        cols = [d[0] for d in cur.description]
        return {"entries": [dict(zip(cols, row)) for row in cur.fetchall()]}
    finally:
        conn.close()

@app.delete("/data/entries/{entry_id}")
def delete_data_entry(entry_id: int, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM sales_entries WHERE id = %s", (entry_id,))
        conn.commit()
        return {"status": "ok", "message": "Entry deleted"}
    finally:
        conn.close()

    return {"status": "success"}

@app.post("/data/upload")
def upload_to_db(file: UploadFile = File(...), team: str = "", mode: str = "append"):
    print("UPLOAD ROUTE HIT", team, file.filename if file else "NO_FILE", flush=True)
    print("STEP 1: route started")
    try:
        team = team.strip()
        if not team:
            raise HTTPException(status_code=400, detail="Team is required")

        mode = (mode or "append").strip().lower()
        if mode not in {"append", "replace"}:
            raise HTTPException(status_code=400, detail="Mode must be append or replace")

        filename = (file.filename or "").lower()
        print("STEP 2: filename =", filename)
        print("STEP 2B: mode =", mode)

        conn = get_db_connection()
        print("STEP 3: db connected")
        cur = conn.cursor()
        inserted = 0

        try:            
            ensure_lookup_value(conn, "teams", team)

            if mode == "replace":
                cur.execute("DELETE FROM sales_entries WHERE team = %s", (team,))
                conn.commit()
                print("STEP 4B: existing team data deleted for replace mode")

            # Mode 1: monthly workbook
            if filename.endswith(".xlsx") or filename.endswith(".xls"):
                workbook = pd.ExcelFile(file.file, engine="openpyxl")
                print("STEP 5: workbook opened")
                print("STEP 6: sheet names =", workbook.sheet_names)

                for s in workbook.sheet_names:
                    try:
                        temp_df = pd.read_excel(workbook, sheet_name=s, engine="openpyxl")
                        print("DEBUG SHEET:", s)
                        print("DEBUG COLUMNS:", list(temp_df.columns))
                    except Exception as exc:
                        print("DEBUG SHEET READ FAILED:", s, str(exc))

                year_sheets = {}
                for sheet_name in workbook.sheet_names:
                    year = parse_year_sheet_name(sheet_name)
                    if year is not None:
                        year_sheets[year] = sheet_name

                if year_sheets:
                    monthly_rows_to_insert = []

                    for year_value, sheet_name in year_sheets.items():
                        df = pd.read_excel(workbook, sheet_name=sheet_name, engine="openpyxl")
                        print("STEP 8: sheet loaded =", sheet_name, "rows =", len(df))
                        df = df.rename(columns=lambda x: str(x).strip())

                        required_cols = {"Sales Person", "Client Name", "Product"}
                        if not required_cols.issubset(set(df.columns)):
                            raise HTTPException(
                                status_code=400,
                                detail=f"Sheet '{sheet_name}' missing required columns",
                            )

                        for month_name in MONTHS:
                            if month_name not in df.columns:
                                df[month_name] = 0

                        # bulk lookup prep
                        sales_people = set()
                        clients = set()
                        products = set()

                        for _, row in df.iterrows():
                            sales_person = str(row["Sales Person"]).strip()
                            client_name = str(row["Client Name"]).strip()
                            product = str(row["Product"]).strip()

                            if not sales_person or not client_name or not product:
                                continue

                            sales_people.add(sales_person)
                            clients.add(client_name)
                            products.add(product)

                            for month_name in MONTHS:
                                qty = pd.to_numeric(row[month_name], errors="coerce")
                                qty = 0 if pd.isna(qty) else float(qty)
                                if qty == 0:
                                    continue

                                entry_date = make_month_date(year_value, month_name)
                                amount = 0.0

                                amount_col_1 = f"{month_name} Amount"
                                amount_col_2 = f"{month_name}_Amount"
                                amount_col_3 = f"Amount {month_name}"

                                for amount_col in [amount_col_1, amount_col_2, amount_col_3]:
                                    if amount_col in df.columns:
                                        raw_amount = pd.to_numeric(row[amount_col], errors="coerce")
                                        amount = 0 if pd.isna(raw_amount) else float(raw_amount)
                                        break

                                monthly_rows_to_insert.append((
                                    team,
                                    sales_person,
                                    client_name,
                                    "",
                                    product,
                                    int(year_value),
                                    month_name,
                                    qty,
                                    amount,
                                    entry_date,
                                ))

                        for value in sales_people:
                            cur.execute("INSERT INTO sales_people (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (value,))
                        for value in clients:
                            cur.execute("INSERT INTO clients (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (value,))
                        for value in products:
                            cur.execute("INSERT INTO products (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (value,))

                    if monthly_rows_to_insert:
                        cur.executemany("""
                        INSERT INTO sales_entries
                        (team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """, monthly_rows_to_insert)
                        inserted = len(monthly_rows_to_insert)

                    conn.commit()
                    print("STEP 9: monthly commit done, inserted =", inserted)
                    return {
                        "status": "uploaded",
                        "mode": "monthly_excel",
                        "inserted_rows": inserted,
                        "team": team,
                    }
                
                # Mode 2: date-wise Excel
                file.file.seek(0)
                workbook = pd.ExcelFile(file.file, engine="openpyxl")

                expected_cols = {"Sales Person", "Client Name", "Product", "Date", "Quantity"}
                optional_cols = {"Amount"}
                date_frames = []

                for sheet_name in workbook.sheet_names:
                    df_sheet = pd.read_excel(workbook, sheet_name=sheet_name, engine="openpyxl")

                    df_sheet = df_sheet.rename(columns=lambda x: str(x).strip())

                    # FIRST CHECK COLUMNS
                    if not expected_cols.issubset(set(df_sheet.columns)):
                        print(
                            "SKIPPING SHEET MISSING DATE COLS:",
                            sheet_name,
                            list(df_sheet.columns),
                            flush=True
                        )
                        continue

                    # KEEP ONLY REQUIRED COLUMNS
                    keep_cols = list(expected_cols)
                    if "Amount" in df_sheet.columns:
                        keep_cols.append("Amount")

                    df_sheet = df_sheet[keep_cols]

                    # REMOVE BLANK ROWS
                    df_sheet = df_sheet.dropna(how="all")

                    df_sheet = df_sheet.dropna(
                        subset=["Sales Person", "Client Name", "Product", "Date", "Quantity"],
                        how="all"
                    )

                    print(
                        "CLEAN DATE ROWS:",
                        sheet_name,
                        len(df_sheet),
                        flush=True
                    )

                    date_frames.append(df_sheet)

                if date_frames:
                    df = pd.concat(date_frames, ignore_index=True)

                    sales_people = set()
                    clients = set()
                    products = set()
                    date_rows_to_insert = []

                    print("STEP 9A: starting row conversion, rows =", len(df), flush=True)

                    for idx, row in df.iterrows():

                        if idx % 1000 == 0:
                            print("STEP 9B: processed rows =", idx, flush=True)
                        sales_person = str(row["Sales Person"]).strip()
                        client_name = str(row["Client Name"]).strip()
                        product = str(row["Product"]).strip()

                        if sales_person.lower() in {"", "nan", "none"}:
                            continue
                        if client_name.lower() in {"", "nan", "none"}:
                            continue
                        if product.lower() in {"", "nan", "none"}:
                            continue

                        quantity = pd.to_numeric(row["Quantity"], errors="coerce")
                        if pd.isna(quantity) or float(quantity) == 0:
                            continue

                        amount = 0.0
                        if "Amount" in row.index:
                            raw_amount = pd.to_numeric(row["Amount"], errors="coerce")
                            amount = 0 if pd.isna(raw_amount) else float(raw_amount)

                        parsed_date = pd.to_datetime(row["Date"], errors="coerce")
                        if pd.isna(parsed_date):
                            continue

                        entry_date = parsed_date.strftime("%Y-%m-%d")
                        year = year_from_date(entry_date)
                        month = month_from_date(entry_date)

                        sales_people.add(sales_person)
                        clients.add(client_name)
                        products.add(product)

                        date_rows_to_insert.append((
                            team,
                            sales_person,
                            client_name,
                            "",
                            product,
                            year,
                            month,
                            float(quantity),
                            amount,
                            entry_date,
                        ))

                    for value in sales_people:
                        cur.execute("INSERT INTO sales_people (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (value,))
                    for value in clients:
                        cur.execute("INSERT INTO clients (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (value,))
                    for value in products:
                        cur.execute("INSERT INTO products (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (value,))

                    print("STEP 9C: rows ready for DB insert =", len(date_rows_to_insert), flush=True)
                    
                    if date_rows_to_insert:
                        print("STEP 9D: starting DB insert", flush=True)
                        
                        execute_values(
                            cur,
                            """
                            INSERT INTO sales_entries
                            (team, sales_person, client_name, client_category, product, year, month, quantity, amount, entry_date)
                            VALUES %s
                            """,
                            date_rows_to_insert,
                            page_size=1000
                        )

                        print("STEP 9E: DB insert finished", flush=True)
                        
                        inserted = len(date_rows_to_insert)

                    conn.commit()
                    print("STEP 10: date-wise commit done, inserted =", inserted, flush=True)
                    return {
                        "status": "uploaded",
                        "mode": "date_excel",
                        "inserted_rows": inserted,
                        "team": team,
                    }

        finally:
            conn.close()

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(exc)}") from exc

    raise HTTPException(
        status_code=400,
        detail="Excel format not recognized. Use either monthly year-sheet format or date-wise columns: Sales Person, Client Name, Product, Date, Quantity"
    )

@app.post("/admin/clear-database")
def clear_database(user: dict = Depends(get_current_user)):

    if user.get("role") not in ["admin", "super_user"]:
        raise HTTPException(status_code=403, detail="Admin access required")

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("DELETE FROM sales_entries")
        cur.execute("DELETE FROM teams")
        cur.execute("DELETE FROM sales_people")
        cur.execute("DELETE FROM clients")
        cur.execute("DELETE FROM products")

        conn.commit()

        return {
            "status": "success",
            "message": "Database cleared successfully"
        }

    finally:
        conn.close()

@app.post("/reset")
def reset_dashboard():
    global DASHBOARD_CACHE

    DASHBOARD_CACHE = None
    errors = []

    if UPLOAD_FILE_PATH.exists():
        gc.collect()
        last_exc = None

        for _ in range(5):
            try:
                UPLOAD_FILE_PATH.unlink()
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                time.sleep(0.3)

        if last_exc is not None and UPLOAD_FILE_PATH.exists():
            errors.append(f"Could not delete uploaded file: {str(last_exc)}")

    if CACHE_FILE_PATH.exists():
        gc.collect()
        last_exc = None

        for _ in range(5):
            try:
                CACHE_FILE_PATH.unlink()
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                time.sleep(0.2)

        if last_exc is not None and CACHE_FILE_PATH.exists():
            errors.append(f"Could not delete cache file: {str(last_exc)}")

    if UPLOAD_FILE_PATH.exists():
        errors.append("Uploaded Excel file still exists after reset.")
    if CACHE_FILE_PATH.exists():
        errors.append("Dashboard cache file still exists after reset.")

    if errors:
        raise HTTPException(status_code=500, detail=" | ".join(errors))

    return {
        "message": "Dashboard reset successfully",
        "status": "reset",
        "has_upload": UPLOAD_FILE_PATH.exists(),
        "has_cache_file": CACHE_FILE_PATH.exists(),
        "cached_in_memory": DASHBOARD_CACHE is not None,
    }


@app.post("/salesperson-insights")
def salesperson_insights(payload: SalespersonInsightsRequest):
    if payload.data_source == "database":
        dashboard_payload = get_database_dashboard_payload(payload.team or "")
    else:
        dashboard_payload = get_dashboard_payload()

    scorecards = dashboard_payload.get("sales_scorecards") or []
    if payload.salesperson_names:
        names = set(payload.salesperson_names)
        scorecards = [item for item in scorecards if item.get("name") in names]

    insights = [generate_salesperson_insight(item, dashboard_payload) for item in scorecards]
    provider = "gemini" if any(item.get("provider") == "gemini" for item in insights) else "fallback"

    return {
        "provider": provider,
        "count": len(insights),
        "insights": insights,
        "meta": {
            "ai_enabled": AI_INSIGHTS_ENABLED,
            "gemini_configured": bool(GEMINI_API_KEY),
            "gemini_model": GEMINI_MODEL,
            "generated_at": now_iso(),
            "data_source": payload.data_source,
            "team": payload.team,
        },
    }

@app.post("/api/visit-entry")
def create_visit_entry(payload: VisitEntryRequest, user: dict = Depends(get_current_user)):
    row = {
        "created_by": user.get("username", ""),
        "created_at": now_iso(),
        "team": payload.team.strip() if user.get("role") == "admin" else user.get("team", ""),
        "sales_person": payload.sales_person.strip() if user.get("role") == "admin" else user.get("username", ""),
        "client_name": payload.client_name.strip(),
        "client_category": payload.client_category.strip(),
        "product": payload.product.strip(),
        "meeting_date": payload.meeting_date,
        "meeting_time": payload.meeting_time,
        "meeting_type": payload.meeting_type.strip(),
        "meeting_status": payload.meeting_status.strip(),
        "client_response": payload.client_response.strip(),
        "order_amount": payload.order_amount,
        "quantity": payload.quantity,
        "future_potential": payload.future_potential,
        "next_meeting_date": payload.next_meeting_date,
        "next_meeting_time": payload.next_meeting_time,
        "notes": payload.notes.strip(),
    }

    if not row["team"] or not row["sales_person"] or not row["client_name"] or not row["product"]:
        raise HTTPException(status_code=400, detail="team, sales_person, client_name, product are required")
    if not row["meeting_date"] or not row["meeting_time"] or not row["meeting_type"] or not row["meeting_status"]:
        raise HTTPException(status_code=400, detail="meeting date/time/type/status are required")

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO visit_entries (
                created_by, created_at, team, sales_person, client_name, client_category, product,
                meeting_date, meeting_time, meeting_type, meeting_status,
                client_response, order_amount, quantity, future_potential,
                next_meeting_date, next_meeting_time, notes
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            row["created_by"], row["created_at"], row["team"], row["sales_person"],
            row["client_name"], row["client_category"], row["product"], row["meeting_date"], row["meeting_time"],
            row["meeting_type"], row["meeting_status"], row["client_response"],
            row["order_amount"], row["quantity"], row["future_potential"], row["next_meeting_date"],
            row["next_meeting_time"], row["notes"]
        ))
        conn.commit()
        return {"status": "ok", "message": "Visit saved successfully"}
    finally:
        conn.close()

@app.post("/api/visit-entries/bulk")
def create_visit_entries_bulk(payload: VisitBulkRequest, user: dict = Depends(get_current_user)):
    if not payload.visits:
        raise HTTPException(status_code=400, detail="No visits provided")

    rows = []

    for item in payload.visits:
        row = {
            "created_by": user.get("username", ""),
            "created_at": now_iso(),
            "team": item.team.strip() if user.get("role") == "admin" else user.get("team", ""),
            "sales_person": item.sales_person.strip() if user.get("role") == "admin" else user.get("username", ""),
            "client_name": item.client_name.strip(),
            "client_category": item.client_category.strip(),
            "product": item.product.strip(),
            "meeting_date": item.meeting_date,
            "meeting_time": item.meeting_time,
            "meeting_type": item.meeting_type.strip(),
            "meeting_status": item.meeting_status.strip(),
            "client_response": item.client_response.strip(),
            "order_amount": item.order_amount,
            "quantity": item.quantity,
            "future_potential": item.future_potential,
            "next_meeting_date": item.next_meeting_date,
            "next_meeting_time": item.next_meeting_time,
            "notes": item.notes.strip(),
        }

        if not row["team"] or not row["sales_person"] or not row["client_name"] or not row["product"]:
            raise HTTPException(status_code=400, detail="team, sales_person, client_name, product are required")

        if not row["meeting_date"] or not row["meeting_time"] or not row["meeting_type"] or not row["meeting_status"]:
            raise HTTPException(status_code=400, detail="meeting date/time/type/status are required")

        rows.append(row)

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.executemany("""
            INSERT INTO visit_entries (
                created_by, created_at, team, sales_person, client_name, client_category, product,
                meeting_date, meeting_time, meeting_type, meeting_status,
                client_response, order_amount, quantity, future_potential,
                next_meeting_date, next_meeting_time, notes
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, [
            (
                row["created_by"], row["created_at"], row["team"], row["sales_person"],
                row["client_name"], row["client_category"], row["product"],
                row["meeting_date"], row["meeting_time"], row["meeting_type"],
                row["meeting_status"], row["client_response"], row["order_amount"],
                row["quantity"], row["future_potential"], row["next_meeting_date"],
                row["next_meeting_time"], row["notes"]
            )
            for row in rows
        ])

        conn.commit()

        return {
            "status": "ok",
            "saved": len(rows),
            "message": f"{len(rows)} visits saved successfully"
        }

    finally:
        conn.close()

@app.get("/api/visit-entries")
def list_visit_entries(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        if user.get("role") in {"admin", "super_user"}:
            cur.execute("""
                SELECT * FROM visit_entries
                ORDER BY meeting_date DESC, meeting_time DESC, id DESC
            """)
        elif user.get("role") == "team_leader":
            cur.execute("""
                SELECT * FROM visit_entries
                WHERE team = %s
                ORDER BY meeting_date DESC, meeting_time DESC, id DESC
            """, (user.get("team", ""),))
        else:
            cur.execute("""
                SELECT * FROM visit_entries
                WHERE (created_by = %s OR sales_person = %s)
                  AND team = %s
                ORDER BY meeting_date DESC, meeting_time DESC, id DESC
            """, (user.get("username"), user.get("username"), user.get("team", "")))

        cols = [d[0] for d in cur.description]
        return {"visits": [dict(zip(cols, row)) for row in cur.fetchall()]}
    finally:
        conn.close()

@app.get("/api/visit-report")
def visit_report(user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            SELECT
                client_name,
                sales_person,
                COUNT(*) as total_visits,
                SUM(order_amount) as total_order,
                AVG(future_potential) as avg_potential,
                STRING_AGG(client_response, ' | ') as responses,
                STRING_AGG(meeting_status, ' | ') as statuses,
                MAX(meeting_date) as last_visit_date
            FROM visit_entries
            GROUP BY client_name, sales_person
            ORDER BY total_visits DESC
        """)

        rows = cur.fetchall()

        report_items = []
        for row in rows:
            client_name = row[0]
            sales_person = row[1]
            total_visits = row[2] or 0
            total_order = row[3] or 0
            avg_potential = row[4] or 0
            responses = row[5] or ""
            statuses = row[6] or ""
            last_visit_date = row[7] or ""

            risk_level = "low"
            flags = []

            if total_visits >= 3 and total_order <= 0:
                risk_level = "high"
                flags.append("Multiple visits but no order")

            if total_visits >= 5 and total_order < 50000:
                risk_level = "high"
                flags.append("Too many visits with weak order result")

            if avg_potential >= 60 and total_order <= 0:
                risk_level = "high"
                flags.append("High potential claimed but no conversion")

            repeated_price_issue = responses.lower().count("price") >= 2
            repeated_no_response = responses.lower().count("no response") >= 2

            if repeated_price_issue:
                flags.append("Repeated price issue excuse")

            if repeated_no_response:
                flags.append("Repeated no-response excuse")

            if "Need Follow-up" in statuses and total_order <= 0:
                flags.append("Follow-up pending without clear conversion")

            if not flags:
                flags.append("No major accountability issue detected")

            report_items.append({
                "client_name": client_name,
                "sales_person": sales_person,
                "total_visits": total_visits,
                "total_order": total_order,
                "avg_potential": round(avg_potential, 2),
                "responses": responses,
                "statuses": statuses,
                "last_visit_date": last_visit_date,
                "risk_level": risk_level,
                "flags": flags,
                "manager_question": (
                    f"Ask {sales_person}: Why were {total_visits} visits made to {client_name} "
                    f"but order result is {total_order}%s Give clear next conversion plan."
                    if risk_level == "high"
                    else f"Review {client_name} with {sales_person} for next follow-up quality."
                ),
            })

        return {
            "status": "ok",
            "report": report_items,
            "summary": {
                "total_clients_reviewed": len(report_items),
                "high_risk_clients": len([x for x in report_items if x["risk_level"] == "high"]),
            }
        }
    finally:
        conn.close()


@app.delete("/api/visit-entry/{visit_id}")
def delete_visit_entry(visit_id: int, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM visit_entries WHERE id = %s", (visit_id,))
        conn.commit()
        return {"status": "ok", "message": "Visit deleted"}
    finally:
        conn.close()

@app.put("/api/visit-entry/{visit_id}")
def update_visit_entry(visit_id: int, payload: VisitEntryRequest, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            UPDATE visit_entries
            SET team = %s, sales_person = %s, client_name = %s, product = %s,
                meeting_date = %s, meeting_time = %s, meeting_type = %s, meeting_status = %s,
                client_response = %s, order_amount = %s, quantity = %s, future_potential = %s,
                next_meeting_date = %s, next_meeting_time = %s, notes = %s
            WHERE id = %s
        """, (
            payload.team.strip(),
            payload.sales_person.strip(),
            payload.client_name.strip(),
            payload.product.strip(),
            payload.meeting_date,
            payload.meeting_time,
            payload.meeting_type.strip(),
            payload.meeting_status.strip(),
            payload.client_response.strip(),
            payload.order_amount,
            payload.quantity,
            payload.future_potential,
            payload.next_meeting_date,
            payload.next_meeting_time,
            payload.notes.strip(),
            visit_id,
        ))
        conn.commit()
        return {"status": "ok", "message": "Visit updated successfully"}
    finally:
        conn.close()

@app.get("/forecast")
def get_forecast(team: str = "", month: str = "", year: int = 0):
    team = team.strip()
    month = month.strip()[:3].title()

    if not team:
        return []

    if not year:
        year = datetime.now().year

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("SELECT COALESCE(target_type, 'QTY') FROM teams WHERE name = %s", (team,))
        team_row = cur.fetchone()
        team_target_type = (team_row[0] if team_row else "QTY").upper()

        achieved_field = "se.amount" if team_target_type == "AMOUNT" else "se.quantity"

        achieved_field = "amount" if team_target_type == "AMOUNT" else "quantity"

        cur.execute(f"""
            WITH team_users AS (
                SELECT
                    LOWER(TRIM(username)) AS username_key,
                    MIN(TRIM(username)) AS username
                FROM users
                WHERE TRIM(team) = %s
                GROUP BY LOWER(TRIM(username))
            ),
            target_agg AS (
                SELECT
                    LOWER(TRIM(username)) AS username_key,
                    SUM(
                        CASE
                            WHEN %s = 'AMOUNT' AND COALESCE(target_type, 'QTY') = 'AMOUNT'
                                THEN COALESCE(target_value, 0)
                            WHEN %s = 'QTY' AND COALESCE(target_type, 'QTY') = 'QTY'
                                THEN COALESCE(NULLIF(target_value, 0), target_kg, 0)
                            ELSE 0
                        END
                    ) AS sales_target
                FROM sales_targets
                WHERE TRIM(team) = %s
                  AND target_year = %s
                  AND (%s = '' OR target_month = %s)
                GROUP BY LOWER(TRIM(username))
            ),
            entry_agg AS (
                SELECT
                    LOWER(TRIM(sales_person)) AS username_key,
                    SUM(COALESCE({achieved_field}, 0)) AS achieved
                FROM sales_entries
                WHERE TRIM(team) = %s
                  AND year = %s
                  AND (%s = '' OR month = %s)
                GROUP BY LOWER(TRIM(sales_person))
            )
            SELECT
                u.username,
                %s AS target_type,
                COALESCE(t.sales_target, 0) AS sales_target,
                COALESCE(e.achieved, 0) AS achieved
            FROM team_users u
            LEFT JOIN target_agg t ON t.username_key = u.username_key
            LEFT JOIN entry_agg e ON e.username_key = u.username_key
            ORDER BY u.username
        """, (
            team,
            team_target_type,
            team_target_type,
            team,
            year,
            month,
            month,
            team,
            year,
            month,
            month,
            team_target_type,
        ))

        rows = cur.fetchall()
        result = []

        for row in rows:
            target_type = (row[1] or team_target_type).upper()
            target = float(row[2] or 0)
            achieved = float(row[3] or 0)
            percent = (achieved / target * 100) if target else 0
            remaining = target - achieved
            remaining_percent = max(0, 100 - percent)

            result.append({
                "username": row[0],
                "target_type": target_type,
                "unit": "Rs" if target_type == "AMOUNT" else "Qty",
                "sales_target": target,
                "achieved": achieved,
                "difference": achieved - target,
                "remaining": remaining,
                "percent": percent,
                "remaining_percent": remaining_percent,
            })

        return result

    finally:
        cur.close()
        conn.close()
@app.put("/admin/update-user-target/{user_id}")
def admin_update_user_target(user_id: int, payload: UserTargetUpdateRequest, user: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            UPDATE users
            SET sales_target = %s, target_duration = %s
            WHERE id = %s
            """,
            (payload.sales_target, payload.target_duration, user_id),
        )
        conn.commit()
        return {"status": "success", "message": "Target updated successfully"}
    finally:
        cur.close()
        conn.close()

@app.put("/admin/monthly-target")
def save_monthly_target(payload: MonthlyTargetRequest, user: dict = Depends(require_admin)):
    username = payload.username.strip()
    team = payload.team.strip()
    month = payload.month.strip()[:3].title()

    if not username or not team or not month or not payload.year:
        raise HTTPException(status_code=400, detail="username, team, year, month required")

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("SELECT id FROM users WHERE username = %s", (username,))
        row = cur.fetchone()
        user_id = row[0] if row else None

        cur.execute("""
            INSERT INTO sales_targets
            (user_id, username, team, target_year, target_month, target_kg, target_type, target_value)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (username, team, target_year, target_month)
            DO UPDATE SET
                target_kg = EXCLUDED.target_kg,
                target_type = EXCLUDED.target_type,
                target_value = EXCLUDED.target_value
        """, (
            user_id,
            username,
            team,
            int(payload.year),
            month,
            float(payload.target_kg or payload.target_value or 0),
            payload.target_type.upper(),
            float(payload.target_value or payload.target_kg or 0),
        ))

        conn.commit()
        return {"status": "success", "message": "Monthly target saved"}

    finally:
        cur.close()
        conn.close()

@app.get("/admin/monthly-targets")
def list_monthly_targets(year: int, month: str, user: dict = Depends(require_admin)):
    clean_month = month.strip()[:3].title()

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("""
            SELECT
                st.username,
                st.team,
                st.target_year,
                st.target_month,
                COALESCE(t.target_type, 'QTY') AS team_target_type,
                CASE
                    WHEN COALESCE(t.target_type, 'QTY') = 'AMOUNT'
                         AND COALESCE(st.target_type, 'QTY') = 'AMOUNT'
                        THEN COALESCE(st.target_value, 0)
                    WHEN COALESCE(t.target_type, 'QTY') = 'QTY'
                         AND COALESCE(st.target_type, 'QTY') = 'QTY'
                        THEN COALESCE(NULLIF(st.target_value, 0), st.target_kg, 0)
                    ELSE 0
                END AS target_value
            FROM sales_targets st
            LEFT JOIN teams t
                ON TRIM(t.name) = TRIM(st.team)
            WHERE st.target_year = %s
              AND st.target_month = %s
        """, (int(year), clean_month))

        rows = cur.fetchall()

        return {
            "targets": [
                {
                    "username": r[0],
                    "team": r[1],
                    "year": r[2],
                    "month": r[3],
                    "target_type": r[4],
                    "target_value": float(r[5] or 0),
                }
                for r in rows
            ]
        }

    finally:
        cur.close()
        conn.close()

def extract_month_from_question(question: str) -> str:
    q = question.lower()

    month_map = {
        "jan": "Jan", "january": "Jan",
        "feb": "Feb", "february": "Feb",
        "mar": "Mar", "march": "Mar",
        "apr": "Apr", "april": "Apr",
        "may": "May",
        "jun": "Jun", "june": "Jun",
        "jul": "Jul", "july": "Jul",
        "aug": "Aug", "august": "Aug",
        "sep": "Sep", "september": "Sep",
        "oct": "Oct", "october": "Oct",
        "nov": "Nov", "november": "Nov",
        "dec": "Dec", "december": "Dec",
    }

    for key, value in month_map.items():
        if key in q:
            return value

    return ""


def find_best_salesperson(question: str, names: list[str]) -> str:
    q = question.lower()

    for name in names:
        if name and name.lower() in q:
            return name

    # simple partial match
    for name in names:
        parts = name.lower().split()
        if any(part in q for part in parts if len(part) >= 3):
            return name

    return ""


def find_best_product(question: str, products: list[str]) -> str:
    q = question.lower()

    for product in products:
        if product and product.lower() in q:
            return product

    for product in products:
        parts = product.lower().split()
        if any(part in q for part in parts if len(part) >= 4):
            return product

    return ""


@app.post("/api/boss-agent")
def boss_agent(payload: BossAgentRequest, x_boss_agent_key: str = Header(default="")):
    expected_key = os.getenv("BOSS_AGENT_KEY", "").strip()

    if not expected_key:
        raise HTTPException(status_code=500, detail="BOSS_AGENT_KEY is not configured")

    if x_boss_agent_key != expected_key:
        raise HTTPException(status_code=401, detail="Invalid boss agent key")

    question = payload.question.strip()
    selected_team = payload.team.strip()

    if not question:
        raise HTTPException(status_code=400, detail="Question is required")

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        # available teams
        cur.execute("SELECT name, COALESCE(target_type, 'QTY') FROM teams ORDER BY name")
        team_rows = cur.fetchall()
        teams = [{"name": r[0], "target_type": r[1]} for r in team_rows]

        if not selected_team and teams:
            for t in teams:
                if t["name"].lower() in question.lower():
                    selected_team = t["name"]
                    break

        # available sales persons
        if selected_team:
            cur.execute("""
                SELECT DISTINCT sales_person
                FROM sales_entries
                WHERE TRIM(team) = %s

                UNION

                SELECT DISTINCT sales_person
                FROM visit_entries
                WHERE TRIM(team) = %s
            """, (selected_team, selected_team))
        else:
            cur.execute("""
                SELECT DISTINCT sales_person
                FROM sales_entries

                UNION

                SELECT DISTINCT sales_person
                FROM visit_entries
            """)

        sales_people = [r[0] for r in cur.fetchall() if r[0]]
        salesperson = find_best_salesperson(question, sales_people)

        # available products
        if selected_team:
            cur.execute("""
                SELECT DISTINCT product
                FROM sales_entries
                WHERE TRIM(team) = %s
            """, (selected_team,))
        else:
            cur.execute("SELECT DISTINCT product FROM sales_entries")

        products = [r[0] for r in cur.fetchall() if r[0]]
        product = find_best_product(question, products)

        month = extract_month_from_question(question)
        year = datetime.now().year

        # team target type
        team_target_type = "QTY"
        if selected_team:
            cur.execute("SELECT COALESCE(target_type, 'QTY') FROM teams WHERE name = %s", (selected_team,))
            tr = cur.fetchone()
            if tr:
                team_target_type = str(tr[0] or "QTY").upper()

        achieved_field = "amount" if team_target_type == "AMOUNT" else "quantity"

        filters = []
        params = []

        if selected_team:
            filters.append("TRIM(team) = %s")
            params.append(selected_team)

        if salesperson:
            filters.append("LOWER(TRIM(sales_person)) = LOWER(TRIM(%s))")
            params.append(salesperson)

        if product:
            filters.append("LOWER(TRIM(product)) = LOWER(TRIM(%s))")
            params.append(product)

        filters.append("year = %s")
        params.append(year)

        if month:
            filters.append("month = %s")
            params.append(month)

        where_sql = " AND ".join(filters)

        cur.execute(f"""
            SELECT
                COALESCE(SUM(quantity), 0) AS total_qty,
                COALESCE(SUM(amount), 0) AS total_amount,
                COUNT(*) AS total_entries
            FROM sales_entries
            WHERE {where_sql}
        """, tuple(params))

        sales_row = cur.fetchone()
        total_qty = float(sales_row[0] or 0)
        total_amount = float(sales_row[1] or 0)
        total_entries = int(sales_row[2] or 0)

        # visits summary
        visit_filters = []
        visit_params = []

        if selected_team:
            visit_filters.append("TRIM(team) = %s")
            visit_params.append(selected_team)

        if salesperson:
            visit_filters.append("LOWER(TRIM(sales_person)) = LOWER(TRIM(%s))")
            visit_params.append(salesperson)

        if month:
            visit_filters.append("TO_CHAR(meeting_date::date, 'Mon') = %s")
            visit_params.append(month)

        visit_where = " AND ".join(visit_filters) if visit_filters else "1=1"

        cur.execute(f"""
            SELECT
                COUNT(*) AS total_visits,
                COALESCE(SUM(order_amount), 0) AS visit_order_amount,
                COUNT(DISTINCT client_name) AS visited_clients
            FROM visit_entries
            WHERE {visit_where}
        """, tuple(visit_params))

        visit_row = cur.fetchone()
        total_visits = int(visit_row[0] or 0)
        visit_order_amount = float(visit_row[1] or 0)
        visited_clients = int(visit_row[2] or 0)

        # target
        target_value = 0.0
        if salesperson and selected_team:
            if team_target_type == "AMOUNT":
                target_expr = """
                    CASE
                        WHEN COALESCE(target_type, 'QTY') = 'AMOUNT'
                            THEN COALESCE(target_value, 0)
                        ELSE 0
                    END
                """
            else:
                target_expr = """
                    CASE
                        WHEN COALESCE(target_type, 'QTY') = 'QTY'
                            THEN COALESCE(NULLIF(target_value, 0), target_kg, 0)
                        ELSE 0
                    END
                """

            cur.execute(f"""
                SELECT COALESCE(SUM({target_expr}), 0)
                FROM sales_targets
                WHERE LOWER(TRIM(username)) = LOWER(TRIM(%s))
                  AND TRIM(team) = %s
                  AND target_year = %s
                  AND (%s = '' OR target_month = %s)
            """, (salesperson, selected_team, year, month, month))

            target_value = float(cur.fetchone()[0] or 0)

        achieved = total_amount if team_target_type == "AMOUNT" else total_qty
        percent = (achieved / target_value * 100) if target_value else 0
        remaining = target_value - achieved

        unit = "Rs" if team_target_type == "AMOUNT" else "Qty"

        context = {
            "question": question,
            "team": selected_team,
            "team_target_type": team_target_type,
            "salesperson": salesperson,
            "product": product,
            "month": month or "Full Year",
            "year": year,
            "sales": {
                "total_quantity": total_qty,
                "total_amount": total_amount,
                "total_entries": total_entries,
                "achieved": achieved,
                "unit": unit,
            },
            "target": {
                "target_value": target_value,
                "achieved_percent": round(percent, 2),
                "remaining": remaining,
                "unit": unit,
            },
            "visits": {
                "total_visits": total_visits,
                "visited_clients": visited_clients,
                "visit_order_amount": visit_order_amount,
            },
        }

        prompt = (
            "You are a boss sales assistant for Ressichem. "
            "Answer in simple Roman Urdu. Be short, practical, and direct. "
            "Use only the provided data. Do not invent data. "
            "If target is missing, clearly say target set nahi hai. "
            "If amount is zero for AMOUNT team, say amount data upload/enter nahi hua. "
            f"\n\nDATA:\n{json.dumps(context, ensure_ascii=False)}"
        )

        try:
            ai_answer = call_ai_json(prompt)
            answer = ai_answer.get("summary") or json.dumps(ai_answer, ensure_ascii=False)
        except Exception:
            if salesperson:
                answer = (
                    f"{salesperson} ka {month or 'full year'} result: "
                    f"Achieved {achieved:,.0f} {unit}, Target {target_value:,.0f} {unit}, "
                    f"Achievement {percent:.1f}%. Visits {total_visits}, clients visited {visited_clients}."
                )
            else:
                answer = (
                    f"Is question ke liye salesperson clear detect nahi hua. "
                    f"Team: {selected_team or 'not selected'}, Month: {month or 'Full Year'}."
                )

        return {
            "answer": answer,
            "data": context,
        }

    finally:
        cur.close()
        conn.close()

@app.get("/admin/download-backup")
def download_backup(user: dict = Depends(require_admin)):

    conn = get_db_connection()

    try:
        df = pd.read_sql_query("""
            SELECT *
            FROM sales_entries
            ORDER BY entry_date DESC
        """, conn)

        backup_path = DATA_DIR / "sales_backup.xlsx"

        with pd.ExcelWriter(backup_path, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, sheet_name="sales_entries")

        return FileResponse(
            path=backup_path,
            filename="sales_backup.xlsx",
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )

    finally:
        conn.close()

@app.get("/{full_path:path}", include_in_schema=False)
async def serve_react_app(full_path: str):
    if full_path.startswith(("dashboard", "upload", "reset", "salesperson-insights", "api", "data-entry", "form", "data", "forecast", "admin")):
        raise HTTPException(status_code=404, detail="API route not found")
    return FileResponse(FRONTEND_DIST / "index.html")

if __name__ == "__main__":
    print("Starting Sales Dashboard Server...")
    print("Local: http://127.0.0.1:8000")
    print(f"LAN:   http://{get_local_ip()}:8000")
    ensure_database_schema()
    maybe_open_browser()
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
