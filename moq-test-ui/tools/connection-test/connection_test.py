#!/usr/bin/env python3
"""
MoQ relay connection test — 7 sequential checks.

  1. DNS          — hostname resolves to an IP
  2. ICMP ping    — IP responds to ICMP echo  (warn-only; may be filtered)
  3. TCP connect  — port accepts TCP           (warn-only; QUIC-only relays refuse)
  4. H3 insecure  — QUIC/H3 transport reachable, TLS verification disabled
  5. H3 secure    — QUIC/H3 transport reachable, TLS certificate verified
  6. QUIC insecure— MoQT QUIC transport reachable, TLS verification disabled
  7. QUIC secure  — MoQT QUIC transport reachable, TLS certificate verified

Tests 4-7 verify transport-layer connectivity only; MoQT session negotiation and
draft selection are tested by the Relay Probe and Conformance tools.

Outputs a single JSON report to stdout preceded by [check] progress lines.
"""

import argparse
import argparse
import asyncio
import json
import os
import select
import socket
import ssl
import struct
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
import logging

from aiopquic.asyncio.client import connect as quic_connect
from aiopquic.quic.configuration import QuicConfiguration

logging.disable(logging.CRITICAL)

TIMEOUT = 8
# All known MoQT QUIC ALPNs
MOQT_ALPNS = ["moqt-18", "moqt-16", "moq-00"]

# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------

def parse_url(relay_url):
    """Return (host, port, path) from a moqt:// or https:// URL."""
    p = urlparse(relay_url)
    host = p.hostname
    port = p.port or 443
    path = p.path or "/"
    return host, port, path

def as_https(url):
    return url.replace("moqt://", "https://").replace("http://", "https://")

# ---------------------------------------------------------------------------
# Test 1: DNS
# ---------------------------------------------------------------------------

def test_dns(host):
    try:
        t = time.monotonic()
        infos = socket.getaddrinfo(host, None)
        ms = round((time.monotonic() - t) * 1000, 1)
        ips = sorted({i[4][0] for i in infos})
        return {"status": "pass", "ips": ips, "latency_ms": ms}
    except socket.gaierror as e:
        return {"status": "fail", "error": str(e)}

# ---------------------------------------------------------------------------
# Test 2: ICMP Ping
# ---------------------------------------------------------------------------

def _icmp_checksum(data):
    s = 0
    n = len(data) % 2
    for i in range(0, len(data) - n, 2):
        s += data[i] + (data[i + 1] << 8)
    if n:
        s += data[-1]
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return ~s & 0xFFFF

def test_ping(ip, count=3, timeout_s=2):
    ICMP_ECHO = 8
    pid = os.getpid() & 0xFFFF
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    except PermissionError:
        return {"status": "skip", "detail": "ICMP requires elevated privileges"}
    except OSError as e:
        return {"status": "skip", "detail": str(e)}

    rtts = []
    with sock:
        for seq in range(count):
            hdr = struct.pack("!BBHHH", ICMP_ECHO, 0, 0, pid, seq)
            payload = b"moq-connection-test"
            csum = _icmp_checksum(hdr + payload)
            hdr = struct.pack("!BBHHH", ICMP_ECHO, 0, socket.htons(csum), pid, seq)
            try:
                t = time.monotonic()
                sock.sendto(hdr + payload, (ip, 0))
                if select.select([sock], [], [], timeout_s)[0]:
                    sock.recvfrom(1024)
                    rtts.append(round((time.monotonic() - t) * 1000, 1))
            except (OSError, socket.timeout):
                pass

    if not rtts:
        return {"status": "warn", "detail": f"no ICMP reply (sent {count}) — may be filtered"}
    return {"status": "pass", "avg_ms": round(sum(rtts) / len(rtts), 1),
            "received": len(rtts), "sent": count}

# ---------------------------------------------------------------------------
# Test 3: TCP connect
# ---------------------------------------------------------------------------

def test_tcp(host, port):
    try:
        t = time.monotonic()
        with socket.create_connection((host, port), timeout=5):
            ms = round((time.monotonic() - t) * 1000, 1)
        return {"status": "pass", "latency_ms": ms}
    except (OSError, socket.timeout) as e:
        return {"status": "warn", "detail": str(e)}

# ---------------------------------------------------------------------------
# Tests 4–7: QUIC transport connectivity
# ---------------------------------------------------------------------------

async def test_quic_transport(host, port, alpn_protocols, verify_tls):
    """
    Attempt a QUIC TLS handshake.  If the handshake completes the transport
    layer is considered reachable, regardless of whether the application-level
    ALPN was accepted (ALPN mismatch = server is there, wrong protocol).
    """
    cfg = QuicConfiguration(
        is_client=True,
        alpn_protocols=alpn_protocols,
        server_name=host,
    )
    cfg.verify_mode = ssl.CERT_REQUIRED if verify_tls else ssl.CERT_NONE

    t = time.monotonic()
    try:
        async with asyncio.timeout(TIMEOUT):
            async with quic_connect(host, port, configuration=cfg):
                ms = round((time.monotonic() - t) * 1000, 1)
                return {"status": "pass", "latency_ms": ms}
    except asyncio.TimeoutError:
        return {"status": "fail", "error": "timeout"}
    except Exception as e:
        ms = round((time.monotonic() - t) * 1000, 1)
        err = str(e)
        err_l = err.lower()
        if any(k in err_l for k in ("refused", "no route", "unreachable", "network is")):
            return {"status": "fail", "error": f"unreachable: {e}"}
        if verify_tls and any(k in err_l for k in ("certificate", "verify", "ssl", "tls")):
            return {"status": "fail", "error": f"TLS: {e}"}
        # ALPN mismatch after a completed handshake → transport is up
        if "no_application_protocol" in err_l or "376" in err:
            return {"status": "pass", "latency_ms": ms, "note": "ALPN mismatch"}
        return {"status": "fail", "error": err}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def run(args):
    url = as_https(args.url)
    host, port, _ = parse_url(url)

    report = {
        "url": url,
        "host": host,
        "port": port,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tests": {},
    }

    ICONS = {"pass": "✓", "warn": "⚠", "fail": "✗", "skip": "—"}

    def emit(key, label, r):
        report["tests"][key] = r
        icon = ICONS.get(r["status"], "?")
        extra = r.get("error") or r.get("detail") or r.get("note") or ""
        ms = f' {r["latency_ms"]} ms' if "latency_ms" in r else ""
        print(f"[check] {icon} {label}{ms}{': ' + extra if extra else ''}", flush=True)

    # 1. DNS
    r = test_dns(host)
    emit("dns", "DNS", r)
    if r["status"] == "fail":
        report["summary"] = {"pass": 0, "warn": 0, "fail": 1, "skip": 0}
        print(json.dumps(report), flush=True)
        return 1
    ip = r["ips"][0]

    # 2. ICMP Ping
    emit("ping", "ICMP Ping", test_ping(ip))

    # 3. TCP Connect
    emit("tcp", "TCP Connect", test_tcp(host, port))

    # 4. H3 insecure
    emit("h3_insecure", "H3 (insecure)",
         await test_quic_transport(host, port, ["h3"], verify_tls=False))

    # 5. H3 secure
    emit("h3_secure", "H3 (TLS verified)",
         await test_quic_transport(host, port, ["h3"], verify_tls=True))

    # 6. QUIC insecure
    emit("quic_insecure", "QUIC (insecure)",
         await test_quic_transport(host, port, MOQT_ALPNS, verify_tls=False))

    # 7. QUIC secure
    emit("quic_secure", "QUIC (TLS verified)",
         await test_quic_transport(host, port, MOQT_ALPNS, verify_tls=True))

    counts = {"pass": 0, "warn": 0, "fail": 0, "skip": 0}
    for v in report["tests"].values():
        counts[v["status"]] = counts.get(v["status"], 0) + 1
    report["summary"] = counts

    print(json.dumps(report), flush=True)
    h3_ok   = any(report["tests"].get(k, {}).get("status") == "pass"
                  for k in ("h3_insecure", "h3_secure"))
    quic_ok = any(report["tests"].get(k, {}).get("status") == "pass"
                  for k in ("quic_insecure", "quic_secure"))
    return 0 if (h3_ok or quic_ok) else 1


def main():
    p = argparse.ArgumentParser(description="MoQ relay connection test")
    p.add_argument("--url", required=True, help="Relay URL (https:// or moqt://)")
    args = p.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()



if __name__ == "__main__":
    main()
