#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exchange {
    Shanghai,
    Shenzhen,
    Beijing,
}

pub fn valid_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit())
}

pub fn is_legacy_beijing(code: &str) -> bool {
    valid_code(code)
        && ["43", "83", "87"]
            .iter()
            .any(|prefix| code.starts_with(prefix))
}

pub fn exchange(code: &str) -> Option<Exchange> {
    if !valid_code(code) {
        return None;
    }
    if code.starts_with("92") || code.starts_with(['4', '8']) {
        return Some(Exchange::Beijing);
    }
    if code.starts_with(['5', '6', '9']) {
        return Some(Exchange::Shanghai);
    }
    Some(Exchange::Shenzhen)
}

pub fn tencent_symbol(code: &str) -> Option<String> {
    let prefix = match exchange(code)? {
        Exchange::Shanghai => "sh",
        Exchange::Shenzhen => "sz",
        Exchange::Beijing => "bj",
    };
    Some(format!("{prefix}{code}"))
}

pub fn eastmoney_market(code: &str) -> Option<i32> {
    exchange(code).map(|exchange| match exchange {
        Exchange::Shanghai => 1,
        Exchange::Shenzhen | Exchange::Beijing => 0,
    })
}

pub fn eastmoney_secid(code: &str) -> Option<String> {
    Some(format!("{}.{code}", eastmoney_market(code)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_shenzhen_shanghai_and_beijing_codes() {
        assert_eq!(tencent_symbol("600519").as_deref(), Some("sh600519"));
        assert_eq!(eastmoney_secid("600519").as_deref(), Some("1.600519"));
        assert_eq!(tencent_symbol("000858").as_deref(), Some("sz000858"));
        assert_eq!(eastmoney_secid("000858").as_deref(), Some("0.000858"));
        assert_eq!(tencent_symbol("510300").as_deref(), Some("sh510300"));
        assert_eq!(tencent_symbol("920982").as_deref(), Some("bj920982"));
        assert_eq!(eastmoney_secid("920982").as_deref(), Some("0.920982"));
    }

    #[test]
    fn identifies_legacy_beijing_codes_without_silently_remapping_them() {
        for code in ["430047", "832982", "873001"] {
            assert!(is_legacy_beijing(code));
            assert_eq!(exchange(code), Some(Exchange::Beijing));
        }
        assert!(!is_legacy_beijing("920982"));
        assert_eq!(tencent_symbol("123"), None);
    }
}
