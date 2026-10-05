"""Emit actual host inspection responses for the extension boundary tests."""
import json
import sys
from unittest.mock import patch
from test_host import host, job

responses = []
for count in (40000, 64000, 64001):
    payload = job(args={"unicode": "\U0001f600" * 32001}, result="\U0001f680" * 32001,
                  flow_status={"unicode": "\U0001f600" * 32001})
    logs = "\U0001f600" * count
    with patch.object(host, "get_json", side_effect=[payload, logs]):
        response = host.inspection("https://fixture.example", "synthetic-only", "fixture", payload["id"])
        responses.append(json.loads(host.encode_response(response)))
sys.stdout.write(json.dumps(responses, ensure_ascii=True))
