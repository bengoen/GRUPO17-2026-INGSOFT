import csv
import json
import re
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt


ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
SUMMARY = RESULTS / "hu001-summary.json"
GRAPH = ROOT / "response_time_hu001.png"
TARGET_LABEL = "03 POST crear solicitud"
THRESHOLD_MS = 1000
RUN_PATTERN = re.compile(r"hu001-(\d+)u-(\d+)s\.jtl$")


def percentile(values, pct):
    if not values:
        return None
    ordered = sorted(values)
    index = round((pct / 100) * (len(ordered) - 1))
    return ordered[index]


def read_run(path):
    samples_by_label = defaultdict(list)
    failures_by_label = defaultdict(int)

    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            label = row["label"]
            elapsed = int(float(row["elapsed"]))
            success = row.get("success", "").lower() == "true"

            samples_by_label[label].append(elapsed)
            if not success:
                failures_by_label[label] += 1

    by_label = {}
    for label, values in samples_by_label.items():
        by_label[label] = {
            "samples": len(values),
            "avg_ms": round(sum(values) / len(values), 2),
            "min_ms": min(values),
            "max_ms": max(values),
            "p90_ms": percentile(values, 90),
            "p95_ms": percentile(values, 95),
            "failures": failures_by_label[label],
            "over_threshold_1000ms": sum(1 for value in values if value > THRESHOLD_MS),
            "values": values,
        }

    return by_label


def clean_for_json(by_label):
    clean = {}
    for label, data in by_label.items():
        clean[label] = {key: value for key, value in data.items() if key != "values"}
    return clean


def main():
    run_files = []
    for path in RESULTS.glob("hu001-*u-*s.jtl"):
        match = RUN_PATTERN.match(path.name)
        if match:
            run_files.append((int(match.group(1)), int(match.group(2)), path))

    if not run_files:
        raise SystemExit("No hay resultados escalonados hu001-<usuarios>u-<ramp>s.jtl para analizar.")

    run_files.sort()
    runs = []
    first_break = None

    for users, ramp_seconds, path in run_files:
        by_label = read_run(path)
        target = by_label[TARGET_LABEL]
        target_summary = clean_for_json({TARGET_LABEL: target})[TARGET_LABEL]
        run_summary = {
            "file": str(path.relative_to(ROOT)),
            "users": users,
            "ramp_seconds": ramp_seconds,
            "target": target_summary,
            "by_label": clean_for_json(by_label),
        }
        runs.append(run_summary)
        if first_break is None and target["over_threshold_1000ms"] > 0:
            first_break = {
                "users": users,
                "ramp_seconds": ramp_seconds,
                "over_threshold_1000ms": target["over_threshold_1000ms"],
                "target_avg_ms": target["avg_ms"],
                "target_max_ms": target["max_ms"],
            }

    summary = {
        "target_label": TARGET_LABEL,
        "threshold_ms": THRESHOLD_MS,
        "method": "Carga escalonada: se mantuvo ramp-up de 10 s y se aumento usuarios hasta observar muestras sobre 1000 ms.",
        "first_observed_break": first_break,
        "runs": runs,
    }

    SUMMARY.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    fig, (axis_rt, axis_failures) = plt.subplots(
        2,
        1,
        figsize=(12, 8),
        gridspec_kw={"height_ratios": [3, 1]},
    )

    positions = []
    labels = []
    failure_counts = []
    offset = 0

    for users, ramp_seconds, path in run_files:
        by_label = read_run(path)
        values = by_label[TARGET_LABEL]["values"]
        x_values = list(range(offset + 1, offset + len(values) + 1))
        colors = ["#d64545" if value > THRESHOLD_MS else "#2563eb" for value in values]
        axis_rt.scatter(x_values, values, c=colors, s=18)
        positions.append(offset + max(1, len(values) // 2))
        labels.append(f"{users}u/{ramp_seconds}s")
        failure_counts.append(by_label[TARGET_LABEL]["over_threshold_1000ms"])
        offset += len(values) + 12

    axis_rt.axhline(
        THRESHOLD_MS,
        color="#d64545",
        linestyle="--",
        linewidth=1.4,
        label="Umbral 1000 ms",
    )
    axis_rt.set_title("HU001 - Response time POST /api/loan-requests")
    axis_rt.set_ylabel("Response time (ms)")
    axis_rt.set_xticks(positions)
    axis_rt.set_xticklabels(labels)
    axis_rt.grid(True, alpha=0.25)
    axis_rt.legend()

    bars = axis_failures.bar(labels, failure_counts, color="#d64545")
    for bar, count in zip(bars, failure_counts):
        axis_failures.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + max(failure_counts + [1]) * 0.02,
            str(count),
            ha="center",
            va="bottom",
            fontsize=9,
        )
    axis_failures.set_ylabel("> 1000 ms")
    axis_failures.set_xlabel("Escenario de carga")
    axis_failures.grid(True, axis="y", alpha=0.25)

    plt.tight_layout()
    plt.savefig(GRAPH, dpi=160)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
