import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parent.parent


class DuplicateKeyError(ValueError):
    pass


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate object key: {key}")
        result[key] = value
    return result


def load_strict_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=strict_object)


def main():
    schema = load_strict_json(ROOT / "schemas" / "public-verification-bundle-v1.schema.json")
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    index = load_strict_json(ROOT / "fixtures" / "index.json")
    failures = []

    for entry in index["fixtures"]:
        fixture_path = ROOT / "fixtures" / entry["file"]
        try:
            instance = load_strict_json(fixture_path)
            actual_valid = not list(validator.iter_errors(instance))
        except (json.JSONDecodeError, DuplicateKeyError):
            actual_valid = False
        if actual_valid != entry["expectedSchemaValid"]:
            failures.append(
                f"{entry['id']}: expected schema valid={entry['expectedSchemaValid']}, got {actual_valid}"
            )

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"Draft 2020-12 schema conformance passed for {len(index['fixtures'])} fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
