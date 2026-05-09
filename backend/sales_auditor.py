from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd


def safe_float(value: Any) -> float:
    try:
        if pd.isna(value):
            return 0.0
        return float(value)
    except Exception:
        return 0.0


def load_visit_logs(visits_file: Path) -> List[Dict[str, Any]]:
    if not visits_file.exists():
        return []

    try:
        data = json.loads(visits_file.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
        return []
    except Exception:
        return []


def build_visit_summary(visit_logs: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not visit_logs:
        return {
            "total_visits": 0,
            "salespersons": [],
            "clients_repeated_no_result": [],
            "future_meetings": [],
            "summary_text": "No visit logs found.",
        }

    df = pd.DataFrame(visit_logs).fillna("")

    if "sales_person" not in df.columns:
        df["sales_person"] = ""
    if "client_name" not in df.columns:
        df["client_name"] = ""
    if "meeting_status" not in df.columns:
        df["meeting_status"] = ""
    if "order_amount" not in df.columns:
        df["order_amount"] = 0
    if "future_potential" not in df.columns:
        df["future_potential"] = 0
    if "next_meeting_date" not in df.columns:
        df["next_meeting_date"] = ""

    df["order_amount"] = pd.to_numeric(df["order_amount"], errors="coerce").fillna(0)
    df["future_potential"] = pd.to_numeric(df["future_potential"], errors="coerce").fillna(0)

    salesperson_rows = []
    repeated_no_result = []

    for person, group in df.groupby("sales_person"):
        total_visits = len(group)
        successful_orders = int((group["order_amount"] > 0).sum())
        total_order_value = float(group["order_amount"].sum())
        avg_potential = float(group["future_potential"].mean()) if total_visits else 0

        salesperson_rows.append({
            "sales_person": person,
            "total_visits": total_visits,
            "successful_orders": successful_orders,
            "total_order_value": total_order_value,
            "avg_potential": round(avg_potential, 2),
        })

        for client, client_group in group.groupby("client_name"):
            zero_result_visits = client_group[client_group["order_amount"] <= 0]
            if len(zero_result_visits) >= 3:
                repeated_no_result.append({
                    "sales_person": person,
                    "client_name": client,
                    "visits": len(client_group),
                    "zero_result_visits": len(zero_result_visits),
                    "last_status": str(client_group.iloc[-1].get("meeting_status", "")),
                })

    future_meetings = []
    for _, row in df.iterrows():
        next_date = str(row.get("next_meeting_date", "")).strip()
        if next_date:
            future_meetings.append({
                "sales_person": row.get("sales_person", ""),
                "client_name": row.get("client_name", ""),
                "next_meeting_date": next_date,
                "product": row.get("product", ""),
            })

    salesperson_rows = sorted(salesperson_rows, key=lambda x: (-x["total_order_value"], -x["successful_orders"], -x["total_visits"]))
    repeated_no_result = sorted(repeated_no_result, key=lambda x: (-x["zero_result_visits"], -x["visits"]))
    future_meetings = future_meetings[:20]

    summary_lines = [
        f"Total visit logs: {len(df)}",
        f"Salespersons tracked: {len(salesperson_rows)}",
        f"Repeated no-result client loops: {len(repeated_no_result)}",
        f"Future meetings scheduled: {len(future_meetings)}",
    ]

    return {
        "total_visits": len(df),
        "salespersons": salesperson_rows,
        "clients_repeated_no_result": repeated_no_result,
        "future_meetings": future_meetings,
        "summary_text": "\n".join(summary_lines),
    }


def load_sales_excel_summary(upload_file_path: Path) -> Dict[str, Any]:
    if not upload_file_path.exists():
        return {
            "available": False,
            "summary_text": "Sales workbook not found.",
        }

    try:
        workbook = pd.ExcelFile(upload_file_path, engine="openpyxl")
        year_sheets = []
        for sheet_name in workbook.sheet_names:
            if str(sheet_name).strip().isdigit() and len(str(sheet_name).strip()) == 4:
                year_sheets.append(sheet_name)

        if not year_sheets:
            return {
                "available": False,
                "summary_text": "No year sheets found in sales workbook.",
            }

        latest_sheet = sorted(year_sheets)[-1]
        df = pd.read_excel(workbook, sheet_name=latest_sheet, engine="openpyxl").fillna("")

        col_map = {str(c).strip(): c for c in df.columns}
        sales_person_col = col_map.get("Sales Person") or col_map.get("Salesperson") or col_map.get("Sales Person Name")
        client_col = col_map.get("Client Name") or col_map.get("Client")
        product_col = col_map.get("Product") or col_map.get("Item")
        total_col = col_map.get("Total") or col_map.get("Grand Total")

        if not sales_person_col or not client_col:
            return {
                "available": False,
                "summary_text": "Required columns missing in sales workbook.",
            }

        if not total_col:
            df["Total"] = 0
            total_col = "Total"

        df[total_col] = pd.to_numeric(df[total_col], errors="coerce").fillna(0)

        grouped = df.groupby(sales_person_col)[total_col].sum().sort_values(ascending=False)
        rows = [
            {"sales_person": str(name), "sales_total": float(value)}
            for name, value in grouped.items()
        ]

        return {
            "available": True,
            "sheet_used": latest_sheet,
            "salespersons": rows,
            "summary_text": f"Sales workbook loaded from sheet {latest_sheet}.",
        }

    except Exception as e:
        return {
            "available": False,
            "summary_text": f"Sales workbook read failed: {str(e)}",
        }


def build_combined_audit_text(visit_summary: Dict[str, Any], sales_summary: Dict[str, Any]) -> str:
    lines: List[str] = []

    lines.append("BOSS AUDIT SNAPSHOT")
    lines.append("")
    lines.append("Visit side:")
    lines.append(visit_summary.get("summary_text", "No visit summary"))

    lines.append("")
    lines.append("Top salespersons by visit activity:")
    for row in visit_summary.get("salespersons", [])[:10]:
        lines.append(
            f"- {row['sales_person']}: visits={row['total_visits']}, successful_orders={row['successful_orders']}, "
            f"order_value={row['total_order_value']:.0f}, avg_potential={row['avg_potential']}"
        )

    repeated = visit_summary.get("clients_repeated_no_result", [])
    lines.append("")
    lines.append("Repeated no-result clients:")
    if repeated:
        for row in repeated[:10]:
            lines.append(
                f"- {row['sales_person']} -> {row['client_name']} | visits={row['visits']} | "
                f"zero_result_visits={row['zero_result_visits']} | last_status={row['last_status']}"
            )
    else:
        lines.append("- None")

    lines.append("")
    lines.append("Sales workbook side:")
    lines.append(sales_summary.get("summary_text", "No sales summary"))

    if sales_summary.get("available"):
        for row in sales_summary.get("salespersons", [])[:10]:
            lines.append(f"- {row['sales_person']}: sales_total={row['sales_total']:.0f}")

    return "\n".join(lines)


def generate_rule_based_findings(visit_summary: Dict[str, Any], sales_summary: Dict[str, Any]) -> List[str]:
    findings: List[str] = []

    repeated = visit_summary.get("clients_repeated_no_result", [])
    if repeated:
        worst = repeated[0]
        findings.append(
            f"{worst['sales_person']} bar bar {worst['client_name']} ke paas ja raha hai lekin result zero hai. "
            f"Yahan waste-of-time review banta hai."
        )

    visit_people = {row["sales_person"]: row for row in visit_summary.get("salespersons", [])}
    sales_people = {row["sales_person"]: row for row in sales_summary.get("salespersons", [])} if sales_summary.get("available") else {}

    for person, v in visit_people.items():
        sales_total = safe_float(sales_people.get(person, {}).get("sales_total", 0))
        if v["total_visits"] >= 5 and v["successful_orders"] == 0 and sales_total <= 0:
            findings.append(
                f"{person} ne kaafi visits ki hain lekin order/sales output nazar nahi aa raha. Is bande ki field efficiency check honi chahiye."
            )

    future_meetings = visit_summary.get("future_meetings", [])
    if future_meetings:
        findings.append(
            f"System mein {len(future_meetings)} future meetings scheduled hain. Boss follow-up discipline monitor kar sakta hai."
        )

    if not findings:
        findings.append("Abhi data mein koi clear red flag nahi mili, lekin aur visit logs aane par audit zyada strong hoga.")

    return findings


def call_gemini_for_audit(api_key: Optional[str], combined_text: str) -> Optional[str]:
    if not api_key:
        return None

    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")
        prompt = f"""
Tum ek strict sales audit manager ho.

Neeche visit logs aur sales workbook ka combined audit snapshot diya gaya hai:

{combined_text}

Mujhe Roman Urdu + simple English mein:
1. Top 5 findings
2. Kaun banda andhere mein rakh raha ho sakta hai
3. Kaun client loop waste lag raha hai
4. Kya action boss ko abhi lena chahiye
5. Next week monitoring checklist

Jawab crisp, management-style aur direct do.
"""
        response = model.generate_content(prompt)
        text = getattr(response, "text", None)
        return text.strip() if text else None
    except Exception:
        return None


def get_boss_audit(visits_file: Path, upload_file_path: Path, api_key: Optional[str] = None) -> Dict[str, Any]:
    visit_logs = load_visit_logs(visits_file)
    visit_summary = build_visit_summary(visit_logs)
    sales_summary = load_sales_excel_summary(upload_file_path)
    combined_text = build_combined_audit_text(visit_summary, sales_summary)
    rule_findings = generate_rule_based_findings(visit_summary, sales_summary)
    ai_text = call_gemini_for_audit(api_key, combined_text)

    return {
        "visit_summary": visit_summary,
        "sales_summary": sales_summary,
        "rule_findings": rule_findings,
        "audit_report": ai_text or "\n".join(f"- {item}" for item in rule_findings),
        "combined_snapshot": combined_text,
    }