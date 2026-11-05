import copy
import gzip
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import encrypt_data
import fetch_siteimprove as fetch
import progress_history as history
import publish_progress as publication
import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import base64


def observation(timestamp="2026-11-05T07:15:00+00:00"):
    return {
        "generated_at": timestamp, "in_progress": False, "collection_complete": True,
        "sites": [{
            "id": 1, "url": "https://example.umich.edu/site/", "site_name": "Example",
            "tags": ["tag:WP-Sites"], "target_percentage": 98, "pages": 10,
            "scan_status": "ok", "issues_available": True, "pdfs_available": True,
            "pdf_count": 1, "pdfs_with_issues": 1, "pdf_total_issues": 4,
            "by_level": {level: {"issues": 2, "occurrences": 10} for level in history.LEVELS},
        }],
    }


class HistoryTests(unittest.TestCase):
    def test_normalization_and_reporting_date(self):
        data = history.normalize(observation("2026-11-05T02:00:00Z"), "fixture")
        self.assertEqual(data["reporting_date"], "2026-11-04")
        self.assertEqual(data["sites"][0]["key"], "id:1")
        self.assertTrue(data["sites"][0]["issues_reliable"])

    def test_dst_local_dates(self):
        for timestamp, date in [("2026-03-08T07:00:00Z", "2026-03-08"), ("2026-11-01T07:00:00Z", "2026-11-01")]:
            self.assertEqual(history.normalize(observation(timestamp), "test")["reporting_date"], date)

    def test_missing_failed_estimated_and_legacy(self):
        for change in [
            {"target_percentage": None}, {"target_estimated": True},
            {"scan_status": "failed"}, {"errors": ["API failure"]},
        ]:
            data = observation()
            data["sites"].append({**copy.deepcopy(data["sites"][0]), "id": 2, **change})
            row = history.normalize(data, "fixture")["sites"][1]
            self.assertFalse(row["eligible"])
            self.assertTrue(row["reasons"])
        data = observation()
        del data["sites"][0]["issues_available"]
        row = history.normalize(data, "old", historical=True)["sites"][0]
        self.assertTrue(row["eligible"])
        self.assertFalse(row["issues_reliable"])

    def test_zero_is_not_missing(self):
        data = observation()
        data["sites"][0]["target_percentage"] = 0
        data["sites"][0]["by_level"]["A"]["occurrences"] = 0
        normalized = history.normalize(data, "test")
        self.assertTrue(normalized["sites"][0]["eligible"])
        self.assertTrue(normalized["sites"][0]["issues_reliable"])

    def test_reject_incomplete_duplicate_and_naive_time(self):
        for mutate in [
            lambda x: x.update(in_progress=True),
            lambda x: x.update(generated_at="2026-11-05T07:00:00"),
            lambda x: x["sites"].append(copy.deepcopy(x["sites"][0])),
        ]:
            data = observation()
            mutate(data)
            with self.assertRaises(ValueError):
                history.normalize(data, "test")

    def test_exclusions_and_unknown_identity(self):
        data = observation()
        data["sites"].append({**copy.deepcopy(data["sites"][0]), "id": 2, "tags": ["tag:Development"]})
        self.assertEqual(len(history.normalize(data, "test")["sites"]), 1)
        data["sites"][0]["id"] = None
        self.assertEqual(history.normalize(data, "test")["sites"][0]["key"], "url:example.umich.edu/site")

    def test_historical_authentication_artifacts_are_excluded(self):
        data = observation()
        for i, url in enumerate(["https://weblogin.umich.edu/SSO", "https://example.invalid/test_login", "https://user:password@example.invalid/"], 2):
            data["sites"].append({**copy.deepcopy(data["sites"][0]), "id": i, "url": url})
        self.assertEqual(len(history.normalize(data, "git:test", historical=True)["sites"]), 1)

    def test_archive_repeatable_and_multiple_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            first = history.append_snapshot(observation(), directory, "fixture")
            raw = first.read_bytes()
            history.append_snapshot(observation(), directory, "fixture")
            self.assertEqual(raw, first.read_bytes())
            repeated = history.append_snapshot(observation(), directory, "another-commit")
            self.assertEqual(repeated, first)
            self.assertEqual(len(list(directory.glob("*.json.gz"))), 1)
            history.append_snapshot(observation("2026-11-05T09:00:00Z"), directory, "fixture2")
            index = json.loads((directory / "index.json").read_text())
            self.assertEqual(len(index["entries"]), 2)
            self.assertEqual(json.loads(gzip.decompress(raw))["schema_version"], 1)

    def test_departments_and_ambiguity(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "mapping.csv"
            path.write_text("site_id,url,department\n1,https://www.example.umich.edu/site/,History\n")
            data = history.load_departments(path)
            self.assertEqual(data["by_url"]["example.umich.edu/site"], "History")
            for content in [
                "site_id,url,department\n1,,A\n1,,B\n",
                "site_id,url,department\n,https://example.edu/,A\n,https://www.example.edu,B\n",
                "site_id,url,department\n,,A\n",
                "site_id,url,department\n1\n",
                "site_id,url,department\n1,,A,extra\n",
            ]:
                path.write_text(content)
                with self.assertRaises(ValueError):
                    history.load_departments(path)

    def test_normalized_url_default_ports_and_credentials(self):
        self.assertEqual(history.normalized_url("https://www.example.edu:443/site/"), "example.edu/site")
        self.assertEqual(history.normalized_url("http://example.edu:8080/site/"), "example.edu:8080/site")
        with self.assertRaises(ValueError):
            history.normalized_url("https://user:password@example.edu/site")


class FetchTests(unittest.TestCase):
    def response_error(self, status):
        response = requests.Response()
        response.status_code = status
        return requests.HTTPError(response=response)

    def test_issue_error_is_never_zero(self):
        for code in (403, 404):
            with patch.object(fetch, "paginate", side_effect=self.response_error(code)):
                self.assertIsNone(fetch.fetch_site_issues(None, 1))
        with patch.object(fetch, "paginate", side_effect=self.response_error(503)):
            with self.assertRaises(requests.HTTPError):
                fetch.fetch_site_issues(None, 1)

    def test_malformed_success_cannot_be_zero_issues(self):
        with patch.object(fetch, "get", return_value={"error": "invalid payload"}):
            with self.assertRaisesRegex(ValueError, "expected items array"):
                fetch.paginate(None, "/sites")
        for value in (None, -1, 1.5, True):
            with self.assertRaisesRegex(ValueError, "occurrence count"):
                fetch.aggregate_site_issues([{"conformance": "A", "occurrences": value}])

    def test_pdf_missing_counts_are_unknown_not_zero(self):
        result = fetch.summarize_pdfs([{"url": "https://example.invalid/test.pdf"}])
        self.assertEqual(result["pdf_count"], 1)
        self.assertIsNone(result["pdf_total_issues"])
        self.assertIsNone(result["pdfs_with_issues"])

    def test_pdf_unavailable_is_not_empty(self):
        with patch.object(fetch, "paginate", side_effect=self.response_error(403)):
            self.assertIsNone(fetch.fetch_site_pdfs(None, 1))

    def test_failed_collection_preserves_both_latest_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ("sites.json", "rules.json"):
                (directory / name).write_text("last-good")
            with patch.dict(os.environ, {"SITEIMPROVE_EMAIL": "fixture", "SITEIMPROVE_API_KEY": "fixture", "SITEIMPROVE_OUTPUT_DIR": temporary}), \
                 patch.object(fetch, "ping"), patch.object(fetch, "paginate", return_value=[{"id": 1, "url": "https://example.edu"}]), \
                 patch.object(fetch, "load_site_tag_csv", return_value=({}, {}, {})), patch.object(fetch, "load_inventory_rows", return_value=[]), \
                 patch.object(fetch, "fetch_site_target", side_effect=RuntimeError("fixture failure")):
                with self.assertRaisesRegex(RuntimeError, "Collection incomplete"):
                    fetch.main()
            for name in ("sites.json", "rules.json"):
                self.assertEqual((directory / name).read_text(), "last-good")

    def test_successful_collection_records_quality(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"SITEIMPROVE_EMAIL": "fixture", "SITEIMPROVE_API_KEY": "fixture", "SITEIMPROVE_OUTPUT_DIR": temporary}), \
                 patch.object(fetch, "ping"), patch.object(fetch, "paginate", return_value=[{"id": 1, "url": "https://example.edu", "pages": 10}]), \
                 patch.object(fetch, "load_site_tag_csv", return_value=({}, {}, {})), patch.object(fetch, "load_inventory_rows", return_value=[]), \
                 patch.object(fetch, "fetch_site_target", return_value={"site_target_percentage": 98, "accessibility_dci_target_score": 99}), \
                 patch.object(fetch, "fetch_site_issues", return_value=[]), patch.object(fetch, "fetch_site_detail", return_value={}), \
                 patch.object(fetch, "fetch_site_pdfs", return_value=None), patch.object(fetch, "fetch_misspelling_counts", return_value={}), \
                 patch.object(fetch, "fetch_crawl_status", return_value={}):
                fetch.main()
            data = json.loads((Path(temporary) / "sites.json").read_text())
            self.assertTrue(data["collection_complete"])
            self.assertTrue(data["sites"][0]["issues_available"])
            self.assertIsNone(data["sites"][0]["pdf_count"])
            self.assertFalse(data["sites"][0]["pdfs_available"])


class PublicationTests(unittest.TestCase):
    def test_encrypted_history_and_shared_salt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            history.append_snapshot(observation(), data / "history", "test")
            (data / "sites.json").write_text(json.dumps(observation()))
            for name in ("rules.json", "departments.json", "refresh-status.json"):
                (data / name).write_text("{}")
            output = root / "published"
            with patch.object(encrypt_data, "ROOT", root), patch.dict(os.environ, {"DASHBOARD_PASSWORD": "fixture-only"}), patch.object(sys, "argv", ["encrypt_data.py", str(output)]):
                encrypt_data.main()
            resources = [json.loads(p.read_text()) for p in output.rglob("*.enc.json")]
            self.assertEqual(len({p["salt"] for p in resources}), 1)
            self.assertFalse(list(output.rglob("*.gz")))
            self.assertFalse([p for p in output.rglob("*.json") if not p.name.endswith(".enc.json")])
            for payload in resources:
                key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(payload["salt"]), iterations=payload["iterations"]).derive(b"fixture-only")
                plain = AESGCM(key).decrypt(base64.b64decode(payload["iv"]), base64.b64decode(payload["ct"]), None)
                if payload.get("compression"):
                    plain = gzip.decompress(plain)
                self.assertIsInstance(json.loads(plain), dict)

    def test_publication_preserves_history_and_last_good_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            origin, repo, collection = root / "origin.git", root / "repo", root / "collection"
            def run(*args, cwd=None):
                subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)
            run("init", "--bare", "--initial-branch=main", str(origin))
            run("clone", str(origin), str(repo))
            data = repo / "data"
            data.mkdir()
            (data / "site-departments.csv").write_text("site_id,url,department\n")
            history.append_snapshot(observation("2026-11-04T07:00:00Z"), data / "history", "earlier")
            (data / "sites.json").write_text(json.dumps(observation("2026-11-04T07:00:00Z")))
            (data / "rules.json").write_text("{}")
            run("add", ".", cwd=repo)
            run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m",
                "fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>", cwd=repo)
            run("push", "origin", "main", cwd=repo)
            collection.mkdir()
            (collection / "sites.json").write_text(json.dumps(observation()))
            (collection / "rules.json").write_text("{}")
            history.append_snapshot(observation(), collection / "history", "new")
            env = {"GITHUB_SERVER_URL": "https://example.invalid", "GITHUB_REPOSITORY": "fixture/repo", "GITHUB_RUN_ID": "1"}
            original_git = publication.git
            contested = False

            def concurrent_push(*args, **kwargs):
                nonlocal contested
                if args[:2] == ("push", "origin") and not contested:
                    contested = True
                    sibling = root / "concurrent"
                    run("clone", str(origin), str(sibling))
                    history.append_snapshot(observation("2026-11-04T09:00:00Z"), sibling / "data/history", "concurrent")
                    (sibling / "data/site-departments.csv").write_text("site_id,url,department\n1,,History\n")
                    run("add", "data", cwd=sibling)
                    run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m",
                        "concurrent fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>", cwd=sibling)
                    run("push", "origin", "main", cwd=sibling)
                return original_git(*args, **kwargs)

            with patch.object(publication, "ROOT", repo), patch.dict(os.environ, env):
                with patch.object(publication, "git", side_effect=concurrent_push):
                    publication.publish(collection, True)
                publication.publish(collection, False)
            latest = subprocess.check_output(["git", "show", "origin/main:data/sites.json"], cwd=repo)
            self.assertEqual(json.loads(latest)["generated_at"], observation()["generated_at"])
            index = json.loads(subprocess.check_output(["git", "show", "origin/main:data/history/index.json"], cwd=repo))
            self.assertTrue(contested)
            self.assertEqual(len(index["entries"]), 3)
            status = json.loads(subprocess.check_output(["git", "show", "origin/main:data/refresh-status.json"], cwd=repo))
            self.assertFalse(status["success"])
            mapping = json.loads(subprocess.check_output(["git", "show", "origin/main:data/departments.json"], cwd=repo))
            self.assertEqual(mapping["by_id"]["1"], "History")


if __name__ == "__main__":
    unittest.main()
