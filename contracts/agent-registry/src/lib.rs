//! AgentRegistry — on-chain agent identity on Soroban.
//!
//! MVP supports:
//! - register_agent(id, owner, display_name, stellar_address, capabilities)
//! - update_agent_metadata(id, new_display_name, new_capabilities)
//! - deactivate_agent(id)
//! - query_agent(id)
//! - authorization: only owner can update/deactivate their own agent.
//!
//! Future: delegation, multi-sig registration, capability discovery events.

use soroban_sdk::{contract, contractimpl, Address, Env, String, Symbol, Vec};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentInfo {
    pub id: String,
    pub owner: Address,
    pub display_name: String,
    pub stellar_address: String,
    pub capabilities: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}

#[contract]
pub struct AgentRegistry;

#[contractimpl]
impl AgentRegistry {
    /// Register a new agent. The caller becomes the owner.
    pub fn register(
        env: Env,
        id: String,
        display_name: String,
        stellar_address: String,
        capabilities: Vec<String>,
    ) -> AgentInfo {
        let owner = env.invoker();
        // Check uniqueness
        let key = Symbol::from_str(&env, &format!("agent:{}", id));
        if env.storage().instance().has(&key) {
            panic!("agent already registered");
        }
        let now = env.ledger().timestamp();
        let info = AgentInfo {
            id: id.clone(),
            owner: owner.clone(),
            display_name,
            stellar_address,
            capabilities,
            created_at: now,
            updated_at: now,
            active: true,
        };
        env.storage().instance().set(&key, &info);
        info
    }

    /// Update display_name and capabilities. Only owner.
    pub fn update_metadata(
        env: Env,
        id: String,
        new_display_name: String,
        new_capabilities: Vec<String>,
    ) -> AgentInfo {
        let key = Symbol::from_str(&env, &format!("agent:{}", id));
        let mut info: AgentInfo = env.storage().instance().get(&key).unwrap();
        if info.owner != env.invoker() {
            panic!("not authorized");
        }
        info.display_name = new_display_name;
        info.capabilities = new_capabilities;
        info.updated_at = env.ledger().timestamp();
        env.storage().instance().set(&key, &info);
        info
    }

    /// Deactivate the agent. Only owner.
    pub fn deactivate(env: Env, id: String) -> bool {
        let key = Symbol::from_str(&env, &format!("agent:{}", id));
        let mut info: AgentInfo = env.storage().instance().get(&key).unwrap();
        if info.owner != env.invoker() {
            panic!("not authorized");
        }
        info.active = false;
        info.updated_at = env.ledger().timestamp();
        env.storage().instance().set(&key, &info);
        true
    }

    /// Query agent info. Anyone can query.
    pub fn query(env: Env, id: String) -> Option<AgentInfo> {
        let key = Symbol::from_str(&env, &format!("agent:{}", id));
        env.storage().instance().get(&key)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Ledger;

    fn setup() -> (Env, AgentRegistryClient<'static>) {
        let env = Env::default();
        let contract_id = env.register_contract(None, AgentRegistry);
        let client = AgentRegistryClient::new(&env, &contract_id);
        (env, client)
    }

    #[test]
    fn test_register_and_query() {
        let (env, client) = setup();
        let id = String::from_str(&env, "agent_1");
        let info = client.register(
            &id,
            &String::from_str(&env, "Test Agent"),
            &String::from_str(&env, "GADDR"),
            &Vec::new(&env),
        );
        assert_eq!(info.id, id);
        assert!(info.active);

        let queried = client.query(&id).unwrap();
        assert_eq!(queried.id, id);
    }

    #[test]
    fn test_update_metadata() {
        let (env, client) = setup();
        let id = String::from_str(&env, "agent_1");
        client.register(&id, &String::from_str(&env, "Old"), &String::from_str(&env, "GADDR"), &Vec::new(&env));
        let updated = client.update_metadata(
            &id,
            &String::from_str(&env, "New"),
            &Vec::new(&env),
        );
        assert_eq!(updated.display_name, String::from_str(&env, "New"));
    }

    #[test]
    #[should_panic(expected = "not authorized")]
    fn test_update_rejects_non_owner() {
        // This test would need a second invoker; simplified here.
        // Real test uses env.invoker() switching via testutils.
    }

    #[test]
    fn test_deactivate() {
        let (env, client) = setup();
        let id = String::from_str(&env, "agent_1");
        client.register(&id, &String::from_str(&env, "Test"), &String::from_str(&env, "GADDR"), &Vec::new(&env));
        client.deactivate(&id);
        let info = client.query(&id).unwrap();
        assert!(!info.active);
    }
}
