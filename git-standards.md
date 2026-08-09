Type	Purpose	Example
feat	A new feature for the user	feat(auth): add OAuth2 login flow
fix	A bug fix for the user	fix(cart): resolve double-charge on checkout
docs	Documentation changes only	docs(readme): update setup instructions
style	Formatting, white-space, or semi-colons (no code logic changes)	style(ui): reformat button components with Prettier
refactor	Code changes that neither fix a bug nor add a feature	refactor(db): simplify connection pool query logic
perf	A code change that improves performance	perf(image): optimize image compression pipeline
test	Adding missing tests or correcting existing tests	test(user): add unit tests for password validation
build	Changes affecting the build system or dependencies	build(deps): bump mineflayer from 1.20 to 1.21
ci	Changes to CI/CD configuration files and scripts	ci(github): add automated linting workflow
chore	Routine maintenance tasks or config updates	chore: update .gitignore rules
revert	Reverts a previous commit	revert: undo commit "feat: add payment gateway"
