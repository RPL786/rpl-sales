import os
from pathlib import Path

import pandas as pd
import google.generativeai as genai


def load_sales_data(file_path: Path) -> pd.DataFrame:
    df = pd.read_excel(file_path)

    required_columns = ["Date", "Sales Person", "Client Name", "Product", "Amount"]
    missing_columns = [col for col in required_columns if col not in df.columns]
    if missing_columns:
        raise ValueError(f"Missing columns: {', '.join(missing_columns)}")

    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"]).copy()

    df["Amount"] = pd.to_numeric(df["Amount"], errors="coerce").fillna(0)
    df["Year"] = df["Date"].dt.year

    return df


def analyze_sales(df: pd.DataFrame) -> dict:
    if df.empty:
        raise ValueError("Sales file is empty after cleaning invalid rows.")

    this_year = int(df["Year"].max())
    last_year = this_year - 1

    df_last = df[df["Year"] == last_year]
    df_this = df[df["Year"] == this_year]

    sales_last = float(df_last["Amount"].sum())
    sales_this = float(df_this["Amount"].sum())

    growth = ((sales_this - sales_last) / sales_last) * 100 if sales_last != 0 else 0

    sales_person = (
        df.groupby(["Sales Person", "Year"])["Amount"]
        .sum()
        .unstack(fill_value=0)
    )

    clients_last = set(df_last["Client Name"].dropna().unique())
    clients_this = set(df_this["Client Name"].dropna().unique())

    lost_clients = clients_last - clients_this
    new_clients = clients_this - clients_last

    product_sales = df.groupby("Product")["Amount"].sum().sort_values(ascending=False)
    top_product = product_sales.idxmax() if not product_sales.empty else "N/A"

    top_clients = (
        df_this.groupby("Client Name")["Amount"]
        .sum()
        .sort_values(ascending=False)
        .head(3)
    )

    worst_person = None
    worst_drop = 0

    for person in sales_person.index:
        last = sales_person.loc[person, last_year] if last_year in sales_person.columns else 0
        this = sales_person.loc[person, this_year] if this_year in sales_person.columns else 0

        if last > 0:
            drop = last - this
            if drop > worst_drop:
                worst_drop = drop
                worst_person = person

    return {
        "this_year": this_year,
        "last_year": last_year,
        "df_last": df_last,
        "df_this": df_this,
        "sales_last": sales_last,
        "sales_this": sales_this,
        "growth": growth,
        "sales_person": sales_person,
        "lost_clients": lost_clients,
        "new_clients": new_clients,
        "product_sales": product_sales,
        "top_product": top_product,
        "top_clients": top_clients,
        "worst_person": worst_person,
        "worst_drop": worst_drop,
    }


def build_report_lines(result: dict) -> list[str]:
    report_lines = []

    report_lines.append("=== SALES SUMMARY ===")
    report_lines.append(f"Last Year ({result['last_year']}) Sales: {result['sales_last']:.0f}")
    report_lines.append(f"This Year ({result['this_year']}) Sales: {result['sales_this']:.0f}")
    report_lines.append(f"Growth / Decline: {result['growth']:.2f}%")

    report_lines.append("\n=== SALES PERSON PERFORMANCE ===")
    report_lines.append(str(result["sales_person"]))

    report_lines.append("\n=== CLIENT ANALYSIS ===")
    report_lines.append(f"Lost Clients: {len(result['lost_clients'])}")
    report_lines.append(f"New Clients: {len(result['new_clients'])}")

    report_lines.append("\nLost Client Names:")
    if result["lost_clients"]:
        for client in sorted(result["lost_clients"]):
            report_lines.append(f"- {client}")
    else:
        report_lines.append("- None")

    report_lines.append("\nNew Client Names:")
    if result["new_clients"]:
        for client in sorted(result["new_clients"]):
            report_lines.append(f"- {client}")
    else:
        report_lines.append("- None")

    report_lines.append("\n=== PRODUCT PERFORMANCE ===")
    report_lines.append(str(result["product_sales"]))

    report_lines.append("\n=== AI INSIGHTS ===")
    if result["growth"] < 0:
        report_lines.append(f"Sales decreased by {abs(result['growth']):.2f}%")
    else:
        report_lines.append(f"Sales increased by {result['growth']:.2f}%")

    for person in result["sales_person"].index:
        last = result["sales_person"].loc[person, result["last_year"]] if result["last_year"] in result["sales_person"].columns else 0
        this = result["sales_person"].loc[person, result["this_year"]] if result["this_year"] in result["sales_person"].columns else 0

        if last > 0:
            change = ((this - last) / last) * 100
            if change < 0:
                report_lines.append(f"{person} performance dropped by {abs(change):.2f}%")
            else:
                report_lines.append(f"{person} improved by {change:.2f}%")

    if result["lost_clients"]:
        report_lines.append(f"{len(result['lost_clients'])} clients lost")

    if result["new_clients"]:
        report_lines.append(f"{len(result['new_clients'])} new clients added")

    report_lines.append(f"Top performing product: {result['top_product']}")

    report_lines.append("\n=== ADVANCED INSIGHTS ===")
    report_lines.append("Top Clients This Year:")
    if not result["top_clients"].empty:
        for client, amount in result["top_clients"].items():
            report_lines.append(f"- {client}: {amount:.0f}")
    else:
        report_lines.append("- No client data available")

    if result["worst_person"]:
        report_lines.append(
            f"Weakest Sales Person: {result['worst_person']} (Drop: {result['worst_drop']:.0f})"
        )
    else:
        report_lines.append("Weakest Sales Person: N/A")

    report_lines.append("\n=== RECOMMENDATIONS ===")
    if result["growth"] < 0:
        report_lines.append("Overall sales are declining — urgent action required")

    if result["worst_person"]:
        report_lines.append(
            f"Focus on {result['worst_person']}: training or strict monitoring needed"
        )

    if result["lost_clients"]:
        report_lines.append("Review lost clients immediately and prioritize valuable accounts")

    report_lines.append(f"Increase focus on top product: {result['top_product']}")

    if result["new_clients"] and result["sales_this"] < result["sales_last"]:
        report_lines.append(
            "New client additions have not yet offset the decline in overall sales"
        )

    report_lines.append("Track sales team weekly and set clear targets")

    return report_lines


def generate_gemini_report(result: dict) -> str:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return "Gemini API key not found. AI-generated report skipped."

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")

        prompt = f"""
You are a business sales analyst.

Here is the sales data summary:

- Last Year Sales: {result['sales_last']:.0f}
- This Year Sales: {result['sales_this']:.0f}
- Growth: {result['growth']:.2f}%

- Lost Clients: {len(result['lost_clients'])}
- New Clients: {len(result['new_clients'])}

- Top Product: {result['top_product']}
- Weakest Sales Person: {result['worst_person']}

- Top Clients:
{result['top_clients'].to_string() if not result['top_clients'].empty else 'No top client data available'}

Write a professional business report with:
1. Executive Summary
2. Key Problems
3. Opportunities
4. Clear Action Plan

Keep it simple, clear, and professional.
"""
        response = model.generate_content(prompt)
        return response.text.strip()

    except Exception as e:
        return f"AI-generated report failed: {str(e)}"


def save_report(report_lines: list[str], output_file: Path) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        for line in report_lines:
            f.write(line + "\n")


def main():
    base_dir = Path(__file__).resolve().parent.parent
    file_path = base_dir / "data" / "sales.xlsx"
    output_file = base_dir / "output" / "report.txt"

    df = load_sales_data(file_path)
    result = analyze_sales(df)
    report_lines = build_report_lines(result)

    ai_report = generate_gemini_report(result)
    report_lines.append("\n=== AI GENERATED REPORT ===")
    report_lines.append(ai_report)

    for line in report_lines:
        print(line)

    save_report(report_lines, output_file)
    print(f"\nReport saved successfully to: {output_file}")


if __name__ == "__main__":
    main()