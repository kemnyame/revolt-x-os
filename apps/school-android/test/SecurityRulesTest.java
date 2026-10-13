import com.revoltx.school.SecurityRules;

public class SecurityRulesTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        check(SecurityRules.isSchoolUrl(SecurityRules.HOME));
        check(SecurityRules.isMobilePage(SecurityRules.HOME));
        check(SecurityRules.isMobilePage(SecurityRules.ORIGIN + "/mobile/teacher?school=test-school"));
        check(SecurityRules.isMobilePage(SecurityRules.ORIGIN + "/mobile/parent"));
        check(!SecurityRules.isMobilePage(SecurityRules.ORIGIN + "/admin-login"));
        check(!SecurityRules.isMobilePage(SecurityRules.ORIGIN + "/student"));
        check(SecurityRules.isSchoolUrl("https://revolt-x-school.onrender.com:443/admin-login?school=grace-prep-school"));
        for (String input : new String[]{"http://revolt-x-school.onrender.com/mobile", "https://revolt-x-school.onrender.com.attacker.test/", "https://attacker.test@revolt-x-school.onrender.com/", "https://revolt-x-school.onrender.com:444/", "javascript:alert(1)", "file:///private", "content://private", "https://revolt-x-school.onrender.com\\@evil.test", "not a URL"}) check(!SecurityRules.isSchoolUrl(input));
        check(SecurityRules.isExternalUrl("https://checkout.paystack.com/example"));
        check(SecurityRules.isExternalUrl("mailto:school@example.test"));
        check(!SecurityRules.isExternalUrl("file:///private"));
        check(!SecurityRules.isExternalUrl("intent://private"));
        check(!SecurityRules.isExternalUrl("https://user:password@attacker.test"));
        check(!SecurityRules.safeFilename("../../report.pdf").contains("/"));
        check(SecurityRules.safeFilename("...").equals("school-document"));
        check(SecurityRules.safeFilename(null).equals("school-document"));
        check(SecurityRules.safeFilename(new String(new char[200]).replace('\0','a')).length() == 120);
        System.out.println("Android navigation and filename checks passed.");
    }
}
