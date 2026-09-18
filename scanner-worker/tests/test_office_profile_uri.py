from pathlib import PurePosixPath, PureWindowsPath

import pytest

from scandocument.office_engine import _office_profile_uri


@pytest.mark.parametrize(
    "profile,expected",
    [
        (PureWindowsPath(r"C:\Users\QA\office-profile"), "file:///C:/Users/QA/office-profile"),
        (PureWindowsPath(r"\\?\C:\Users\QA\office-profile"), "file:///C:/Users/QA/office-profile"),
        (
            PureWindowsPath(r"\\?\C:\Users\QA\Рабочая папка\office-profile"),
            "file:///C:/Users/QA/%D0%A0%D0%B0%D0%B1%D0%BE%D1%87%D0%B0%D1%8F%20"
            "%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0/office-profile",
        ),
        (PureWindowsPath(r"\\server\share\office-profile"), "file://server/share/office-profile"),
        (PureWindowsPath(r"\\?\UNC\server\share\office-profile"), "file://server/share/office-profile"),
        (PureWindowsPath(r"\\?\unc\server\share\office-profile"), "file://server/share/office-profile"),
        (
            PureWindowsPath(r"\\?\UNC\server\Общая папка\office-profile"),
            "file://server/%D0%9E%D0%B1%D1%89%D0%B0%D1%8F%20%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0/office-profile",
        ),
        (PurePosixPath("/private/tmp/office-profile"), "file:///private/tmp/office-profile"),
        (
            PurePosixPath("/private/tmp/QA профиль/office-profile"),
            "file:///private/tmp/QA%20%D0%BF%D1%80%D0%BE%D1%84%D0%B8%D0%BB%D1%8C/office-profile",
        ),
        (
            PureWindowsPath(r"\\?\C:\QA #100%\office-profile"),
            "file:///C:/QA%20%23100%25/office-profile",
        ),
    ],
)
def test_office_profile_uri_preserves_filesystem_path_and_encodes_uri(profile, expected):
    original = str(profile)
    assert _office_profile_uri(profile) == expected
    assert str(profile) == original


@pytest.mark.parametrize("profile", [PureWindowsPath("relative/profile"), PurePosixPath("relative/profile")])
def test_office_profile_uri_still_rejects_relative_profiles(profile):
    with pytest.raises(ValueError, match="relative"):
        _office_profile_uri(profile)
